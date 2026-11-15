#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { createSource } from "../src/sources/index.js";
import { createRunners } from "../src/agents/index.js";
import { loadTemplates } from "../src/prompts.js";
import { validateTask, readyCandidates } from "../src/task.js";
import { runOnce } from "../src/engine.js";
import { onboard, approve, plan } from "../src/onboard.js";
import { readRunLog, passRateByPromptVersion, statsByTier } from "../src/runlog.js";
import { createNotifier } from "../src/notify.js";
import { cronRun, crontabLine } from "../src/cron.js";
import { fileURLToPath } from "node:url";
import { loadSuite, runBench, compareBench, formatComparison } from "../src/bench.js";
import { propose, listProposals, accept, reject } from "../src/proposals.js";
import { serveBoard, writeBoard } from "../src/board.js";
import { buildProjectState, saveCard, initProject, findConfig } from "../src/app.js";
import fs from "node:fs";
import { discover } from "../src/discover.js";

const HELP = `ungrind: ship your side projects without the grind

Usage: ungrind <command> [--config ungrind.config.yaml] [options]

Commands:
  validate             Check the config and every task card against the contract
  run                  Pick the next ready task and run it through the loop (one task per run)
      --dry-run          Run agent and checks on a branch, but no push, no status or note writes
      --task <id>        Only run this task (it must be ready)
      --skip-conventions Run without an approved conventions file
  cron                 Scheduled entry point: lock, usage pre-check, then up to cron.maxTasksPerRun tasks
      --print-crontab    Print a crontab line for this project (does not install it)
      --schedule "<expr>" Cron schedule for --print-crontab (default every 30 minutes)
  onboard              Strong model drafts .ungrind/conventions.draft.md (read-only)
  approve              Promote the reviewed draft to .ungrind/conventions.md
  plan --task <id>     Planner proposes a crisper card for a task (prints only)
  stats                Pass rates per prompt version and per tier / agent / model from the run log
  propose [--min-failures n]  Draft one conventions improvement from repeated failures in the run log
  proposals            List proposals and their status
  accept <id>          Human approval: append the proposal's addition to the conventions file
  reject <id>          Mark a proposal rejected
  board [--port 4477]  Read-only board of tasks and recent runs on http://127.0.0.1 (localhost only)
      --out <file>       Write a static HTML snapshot instead of serving
  init --dir <folder>  Write a starter config and tasks folder (never overwrites); prints JSON
  discover [--max n]   First pass: the strongest tier reads the repo and drafts feature cards; prints JSON
  state                Print project rules, feature cards, and recent runs as JSON (for front ends)
  card-save            Create or update a card from JSON on stdin (local files); prints JSON
  bench                Run the benchmark suite in throwaway copies of its fixture (no --config needed)
      --suite <file>     Suite file (default benchmarks/strings/suite.yaml)
      --fixture-config <name>  Config inside the fixture, e.g. ungrind.local.yaml
      --prompts-dir <dir> --prompts-version <v>  Benchmark a candidate prompt set
      --compare          Only print the comparison across logged benchmark runs
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || cmd === "help") return console.log(HELP);

  if (cmd === "bench") {
    const suite = loadSuite(typeof args.suite === "string" ? args.suite : "benchmarks/strings/suite.yaml");
    if (!args.compare) {
      const str = (k) => (typeof args[k] === "string" ? args[k] : undefined);
      const r = await runBench(suite, { fixtureConfig: str("fixture-config"), promptsDir: str("prompts-dir"), promptsVersion: str("prompts-version"), verbose: Boolean(args.verbose) });
      console.log(`\n${r.suite} @ ${r.promptVersion}: ${r.passed}/${r.runs} passed, ${r.firstTry} first try, $${r.costUsd.toFixed(3)}\n`);
    }
    console.log(formatComparison(compareBench(suite)));
    return;
  }

  if (cmd === "init") {
    return console.log(JSON.stringify(initProject(typeof args.dir === "string" ? args.dir : ".")));
  }
  if (cmd === "find-config") {
    return console.log(JSON.stringify({ configFile: findConfig(typeof args.dir === "string" ? args.dir : ".") }));
  }

  const config = loadConfig(args.config ?? "ungrind.config.yaml");
  const source = () => createSource(config);
  const runners = () => createRunners(config);
  const templates = () => loadTemplates(config.prompts);

  switch (cmd) {
    case "validate": {
      const tasks = await source().listTasks();
      const ready = new Set(readyCandidates(tasks).map((t) => t.id));
      let bad = 0;
      console.log(`config ok: ${config.file}\nprompt version: ${templates().version}\n`);
      for (const t of tasks) {
        const problems = validateTask(t);
        if (problems.length) bad++;
        const flag = problems.length ? "INVALID" : ready.has(t.id) ? "ready  " : "       ";
        console.log(`${flag} [${t.status}] p${t.priority} ${t.id}: ${t.title}${problems.length ? `\n          - ${problems.join("\n          - ")}` : ""}`);
      }
      console.log(`\n${tasks.length} task(s), ${bad} invalid, ${ready.size} ready to run`);
      process.exitCode = bad ? 1 : 0;
      return;
    }
    case "run": {
      const r = await runOnce({
        config, source: source(), runners: runners(), templates: templates(),
        dryRun: Boolean(args["dry-run"]), onlyId: typeof args.task === "string" ? args.task : null,
        skipConventions: Boolean(args["skip-conventions"]),
        notify: createNotifier(config),
      });
      process.exitCode = r.result === "blocked" ? 2 : 0;
      return;
    }
    case "cron": {
      if (args["print-crontab"]) {
        const schedule = typeof args.schedule === "string" ? args.schedule : undefined;
        return console.log(crontabLine(config, { schedule, bin: fileURLToPath(import.meta.url) }));
      }
      const results = await cronRun({ config, source: source(), runners: runners(), templates: templates(), notify: createNotifier(config) });
      process.exitCode = results.some((r) => r.result === "blocked" || r.result === "error") ? 2 : 0;
      return;
    }
    case "propose": {
      const minFailures = typeof args["min-failures"] === "string" ? Number(args["min-failures"]) : 3;
      await propose({ config, runners: runners(), templates: templates(), minFailures });
      return;
    }
    case "proposals": {
      const list = listProposals(config);
      if (!list.length) return console.log("no proposals yet");
      for (const p of list) console.log(`${p.id}  ${p.status.padEnd(8)}  ${p.problem}`);
      return;
    }
    case "accept":
    case "reject": {
      const id = args._[1];
      if (!id) throw new Error(`${cmd} needs a proposal id (see \`ungrind proposals\`)`);
      (cmd === "accept" ? accept : reject)({ config, id });
      return;
    }
    case "discover": {
      const max = typeof args.max === "string" ? Number(args.max) : 12;
      const r = await discover({ config, source: source(), runners: runners(), templates: templates(), max, log: (m) => console.error(m) });
      return console.log(JSON.stringify(r));
    }
    case "state":
      return console.log(JSON.stringify(await buildProjectState(config, source())));
    case "card-save":
      return console.log(JSON.stringify(saveCard(config, JSON.parse(fs.readFileSync(0, "utf8")))));
    case "board": {
      if (typeof args.out === "string") return console.log(`board written to ${await writeBoard(config, source(), args.out)}`);
      const port = typeof args.port === "string" ? Number(args.port) : 4477;
      await serveBoard(config, source(), { port });
      console.log(`[ungrind] read-only board at http://127.0.0.1:${port} (Ctrl+C to stop)`);
      return;
    }
    case "onboard": await onboard({ config, runners: runners(), templates: templates() }); return;
    case "approve": approve({ config }); return;
    case "plan": {
      if (typeof args.task !== "string") throw new Error("plan needs --task <id>");
      const task = (await source().listTasks()).find((t) => t.id === args.task);
      if (!task) throw new Error(`No task with id ${args.task}`);
      await plan({ config, runners: runners(), templates: templates(), task });
      return;
    }
    case "stats": {
      const records = readRunLog(config.prompts.stateDir);
      const rows = passRateByPromptVersion(records);
      if (!Object.keys(rows).length) return console.log("no runs logged yet");
      console.log("By prompt version:");
      for (const [v, r] of Object.entries(rows)) {
        console.log(`  ${v}: ${r.runs} run(s), ${r.passed} done, first-try pass rate ${((100 * r.firstTryPass) / r.runs).toFixed(0)}%`);
      }
      console.log("By tier / agent / model (per attempt):");
      for (const [k, s] of Object.entries(statsByTier(records))) {
        console.log(`  ${k}: ${s.attempts} attempt(s), ${((100 * s.passed) / s.attempts).toFixed(0)}% passed, $${s.costUsd.toFixed(2)} total, avg ${(s.agentMs / s.attempts / 1000).toFixed(0)}s`);
      }
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`ungrind: ${e.message}`);
  process.exitCode = 1;
});
