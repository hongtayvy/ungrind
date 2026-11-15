import fs from "node:fs";
import path from "node:path";

/** Append one JSON record per run to <stateDir>/runs.jsonl. */
/** Logs can hold command output, so keep them out of git even if someone runs `git add -A` in the project. */
export function ensureStateIgnore(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, ".gitignore");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "# Written by Ungrind. Run logs can contain command output, so they stay out of git.\nruns.jsonl\ncron.log\ncron.lock\n*.bak\nrules.backup.*\n");
  }
}

export function writeRunLog(stateDir, record) {
  ensureStateIgnore(stateDir);
  fs.appendFileSync(path.join(stateDir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
}

export function readRunLog(stateDir) {
  const f = path.join(stateDir, "runs.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Per attempt, grouped by tier / agent / model: how often each rung passes and what it costs.
 * This is how a local model compares with the paid tiers (local attempts log $0).
 */
export function statsByTier(records) {
  const out = {};
  for (const r of records) {
    if (r.dryRun) continue;
    for (const a of r.attempts ?? []) {
      const key = `${a.tier} / ${a.agent ?? "claude-code"}${a.model ? ` / ${a.model}` : ""}`;
      const o = (out[key] ??= { attempts: 0, passed: 0, costUsd: 0, agentMs: 0 });
      o.attempts++;
      if (a.passed) o.passed++;
      o.costUsd += a.costUsd ?? 0;
      o.agentMs += a.agentMs ?? 0;
    }
  }
  return out;
}

/** First-try pass rate per prompt version (the number that tells you whether a prompt change helped). */
export function passRateByPromptVersion(records) {
  const out = {};
  for (const r of records) {
    if (r.dryRun || !r.promptVersion || r.result === "nothing-ready") continue;
    const key = r.conventionsVersion ? `${r.promptVersion} conv:${r.conventionsVersion}` : r.promptVersion;
    const o = (out[key] ??= { runs: 0, firstTryPass: 0, passed: 0 });
    o.runs++;
    if (r.result === "done") o.passed++;
    if (r.result === "done" && r.attempts.length === 1) o.firstTryPass++;
  }
  return out;
}
