import path from "node:path";
import { git, currentBranch, changedFiles, commitAll, hasRemote } from "./git.js";
import { nextReady } from "./sources/index.js";
import { slugify } from "./task.js";
import { buildPrompt, parseAgentOutput, readConventions } from "./prompts.js";
import { runVerifiers } from "./verifiers/index.js";
import { writeRunLog } from "./runlog.js";

const rel = (repo, p) => path.relative(repo, p).split(path.sep).join("/");

/** Paths the engine itself writes (state dir, task folder). Never counted as agent work, never committed. */
export function engineExcludes(config) {
  const ex = [rel(config.repo, config.prompts.stateDir)];
  if (config.taskSource.adapter === "local") ex.push(rel(config.repo, path.resolve(config.repo, config.taskSource.path)));
  return ex.filter((p) => p && !p.startsWith(".."));
}

function branchName(config, task) {
  const base = config.guardrails.branchPattern.replace("{slug}", slugify(task.title));
  let name = base, n = 2;
  while (git(config.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFail: true })) name = `${base}-${n++}`;
  if (config.guardrails.protectedBranches.includes(name)) throw new Error(`Refusing to use protected branch name: ${name}`);
  return name;
}

/**
 * One run = at most one task. The engine (not the model) owns the queue, retry counts,
 * escalation, verification, logging and stop conditions.
 */
export async function runOnce({ config, source, runner, templates, dryRun = false, onlyId = null, skipConventions = false, log = console.log }) {
  const started = Date.now();
  const record = {
    ts: new Date().toISOString(), project: config.project, dryRun, promptVersion: templates.version,
    task: null, startTier: null, branch: null, attempts: [], result: null, reason: null,
    totalCostUsd: 0, pushed: false, durationMs: 0,
  };
  const finish = (result, reason = null) => {
    record.result = result;
    record.reason = reason;
    record.durationMs = Date.now() - started;
    writeRunLog(config.prompts.stateDir, record);
    log(`[ungrind] result: ${result}${reason ? ` (${reason})` : ""}`);
    return record;
  };

  const excludes = engineExcludes(config);
  const conventions = readConventions(config.prompts);
  if (!conventions && config.prompts.requireConventions && !skipConventions) {
    if (!dryRun) {
      throw new Error("No approved conventions file. Run `ungrind onboard`, review the draft, then `ungrind approve` (or pass --skip-conventions).");
    }
    log("[ungrind] warning: no approved conventions file (continuing because of --dry-run)");
  }

  if (!git(config.repo, ["rev-parse", "--is-inside-work-tree"], { allowFail: true })) throw new Error(`Not a git repository: ${config.repo}`);
  const base = currentBranch(config.repo);
  const dirty = changedFiles(config.repo, excludes);
  if (dirty.length) throw new Error(`Working tree is not clean (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}). Commit or stash first so the diff guard sees only agent changes.`);

  // Queue: validate against the contract, block bad cards, pick the best ready task.
  const { task, skipped } = await nextReady(source, { dryRun, onlyId });
  for (const s of skipped) log(`[ungrind] ${dryRun ? "would block" : "blocked"} ${s.id}: ${s.reason}`);
  record.skipped = skipped;
  if (!task) { log("[ungrind] nothing ready"); return finish("nothing-ready"); }
  record.task = { id: task.id, title: task.title };
  log(`[ungrind] task: ${task.title} (${task.id})`);

  // Human gate.
  if (task.type && config.gates.humanApprovalTypes.includes(task.type) && !task.approved) {
    const reason = `Needs human approval (type: ${task.type}). Set approved: true on the task, then set it back to Ready.`;
    if (!dryRun) { await source.attach(task, "notes", reason); await source.setStatus(task, "blocked"); }
    return finish("skipped", reason);
  }

  if (!dryRun) await source.setStatus(task, "in_progress");
  let notes = task.notes || (source.loadNotes ? await source.loadNotes(task) : "");

  const { ladder, failuresPerTier, maxCostUsd, models } = config.routing;
  let tierIdx = ladder.indexOf(config.routing.tierBySize[task.size] ?? config.routing.defaultTier);
  if (tierIdx < 0) tierIdx = 0;
  record.startTier = ladder[tierIdx];

  const branch = branchName(config, task);
  git(config.repo, ["checkout", "-b", branch]);
  record.branch = branch;
  log(`[ungrind] branch: ${branch}, starting tier: ${record.startTier}${dryRun ? " (dry run)" : ""}`);

  let success = false, summary = "", failure = "", failsAtTier = 0, reason = null;
  try {
    for (let n = 1; n <= config.guardrails.maxAttempts; n++) {
      const tier = ladder[tierIdx];
      const prompt = buildPrompt({ templates, tier, task, config, conventions, notes, failure });
      log(`[ungrind] attempt ${n}/${config.guardrails.maxAttempts} at ${tier}`);
      const res = await runner.run({ prompt, cwd: config.repo, tier, model: models[tier], timeoutMs: config.agent.timeoutSec * 1000 });
      const attempt = { n, tier, model: models[tier], agentExit: res.exitCode, costUsd: res.usage.costUsd, agentMs: res.durationMs, verifiers: [], passed: false };
      record.attempts.push(attempt);
      record.totalCostUsd += res.usage.costUsd;

      const parsed = parseAgentOutput(res.output);
      let failText = null;
      if (res.exitCode !== 0) failText = `Agent run failed (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}):\n${res.output.slice(-2000)}`;
      else if (parsed.blocked) failText = `Agent reported it could not proceed: ${parsed.blocked}`;
      else {
        const v = await runVerifiers({ config, task, excludes });
        attempt.verifiers = v.results.map((r) => ({ name: r.name, passed: r.passed, durationMs: r.durationMs, output: r.output }));
        const bad = v.results.find((r) => !r.passed);
        if (bad) failText = `Check "${bad.name}" failed:\n${bad.output}`;
        else if (v.files.length === 0) failText = "The agent made no file changes, so nothing satisfies the task.";
      }

      if (!failText) { attempt.passed = true; success = true; summary = parsed.summary; break; }

      attempt.failure = failText.slice(0, 2000);
      failure = failText;
      const note = `Attempt ${n} (${tier}) failed.\n${failText}`;
      notes = `${notes}\n\n${note}`.trim();
      if (!dryRun) await source.attach(task, "notes", note);
      log(`[ungrind] attempt ${n} failed: ${failText.split("\n")[0]}`);

      if (record.totalCostUsd >= maxCostUsd) { reason = `cost ceiling hit ($${record.totalCostUsd.toFixed(2)} >= $${maxCostUsd})`; break; }
      failsAtTier++;
      if (failsAtTier >= failuresPerTier && tierIdx < ladder.length - 1) {
        tierIdx++;
        failsAtTier = 0;
        log(`[ungrind] escalating to ${ladder[tierIdx]}`);
      }
    }

    if (success) {
      const msg = `loop: ${task.title}\n\n${summary}\n\nTask: ${task.id}\nPrompt: ${templates.version}`;
      commitAll(config.repo, msg, excludes);
      if (!dryRun && config.guardrails.push) {
        if (hasRemote(config.repo, config.guardrails.remote)) {
          try { git(config.repo, ["push", "-u", config.guardrails.remote, branch]); record.pushed = true; }
          catch (e) { log(`[ungrind] push failed: ${e.message}`); record.pushError = e.message; }
        } else log(`[ungrind] no remote "${config.guardrails.remote}", skipping push`);
      }
      if (!dryRun) { await source.attach(task, "summary", summary); await source.setStatus(task, "done"); }
      return finish("done");
    }

    reason ??= `max attempts (${config.guardrails.maxAttempts}) reached. Last failure: ${failure.split("\n")[0]}`;
    commitAll(config.repo, `wip(blocked): ${task.title}\n\n${reason}`, excludes); // keep the failed work on the branch
    if (!dryRun) { await source.attach(task, "notes", `Blocked: ${reason}`); await source.setStatus(task, "blocked"); }
    return finish("blocked", reason);
  } finally {
    git(config.repo, ["checkout", base], { allowFail: true });
  }
}
