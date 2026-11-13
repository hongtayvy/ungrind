#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { createSource } from "../src/sources/index.js";
import { createRunner } from "../src/agents/claude-code.js";
import { loadTemplates } from "../src/prompts.js";
import { validateTask, readyCandidates } from "../src/task.js";
import { runOnce } from "../src/engine.js";
import { onboard, approve, plan } from "../src/onboard.js";
import { readRunLog, passRateByPromptVersion } from "../src/runlog.js";
import { createNotifier } from "../src/notify.js";

const HELP = `ungrind: ship your side projects without the grind

Usage: ungrind <command> [--config ungrind.config.yaml] [options]

Commands:
  validate             Check the config and every task card against the contract
  run                  Pick the next ready task and run it through the loop (one task per run)
      --dry-run          Run agent and checks on a branch, but no push, no status or note writes
      --task <id>        Only run this task (it must be ready)
      --skip-conventions Run without an approved conventions file
  onboard              Strong model drafts .ungrind/conventions.draft.md (read-only)
  approve              Promote the reviewed draft to .ungrind/conventions.md
  plan --task <id>     Planner proposes a crisper card for a task (prints only)
  stats                First-try pass rate per prompt version from the run log
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

  const config = loadConfig(args.config ?? "ungrind.config.yaml");
  const source = () => createSource(config);
  const runner = () => createRunner(config.agent);
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
        config, source: source(), runner: runner(), templates: templates(),
        dryRun: Boolean(args["dry-run"]), onlyId: typeof args.task === "string" ? args.task : null,
        skipConventions: Boolean(args["skip-conventions"]),
        notify: createNotifier(config),
      });
      process.exitCode = r.result === "blocked" ? 2 : 0;
      return;
    }
    case "onboard": await onboard({ config, runner: runner(), templates: templates() }); return;
    case "approve": approve({ config }); return;
    case "plan": {
      if (typeof args.task !== "string") throw new Error("plan needs --task <id>");
      const task = (await source().listTasks()).find((t) => t.id === args.task);
      if (!task) throw new Error(`No task with id ${args.task}`);
      await plan({ config, runner: runner(), templates: templates(), task });
      return;
    }
    case "stats": {
      const rows = passRateByPromptVersion(readRunLog(config.prompts.stateDir));
      if (!Object.keys(rows).length) return console.log("no runs logged yet");
      for (const [v, r] of Object.entries(rows)) {
        console.log(`${v}: ${r.runs} run(s), ${r.passed} done, first-try pass rate ${((100 * r.firstTryPass) / r.runs).toFixed(0)}%`);
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
