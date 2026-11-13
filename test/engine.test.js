import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateConfig } from "../src/config.js";
import { createSource } from "../src/sources/index.js";
import { loadTemplates } from "../src/prompts.js";
import { runOnce } from "../src/engine.js";
import { readRunLog } from "../src/runlog.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo(tasks, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "tasks"));
  fs.writeFileSync(path.join(dir, "src/value.txt"), "old\n");
  for (const [name, body] of Object.entries(tasks)) fs.writeFileSync(path.join(dir, "tasks", `${name}.md`), body);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "add", "-A");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const { config, errors } = validateConfig({
    project: "t",
    repo: dir,
    taskSource: { adapter: "local", path: "tasks" },
    // The "test": src/value.txt must say "new".
    verifiers: [{ name: "value check", command: "grep -q '^new$' src/value.txt", timeoutSec: 10 }],
    guardrails: { push: false, maxAttempts: 5 },
    prompts: { requireConventions: false },
    ...overrides,
  });
  assert.deepEqual(errors, []);
  return { dir, config };
}

const card = ({ title = "Set value", status = "Ready", priority = 1, size = "small", files = "[src/value.txt]", extra = "" } = {}) =>
  `---\ntitle: ${title}\nstatus: ${status}\npriority: ${priority}\nsize: ${size}\nfiles: ${files}\n${extra}---\n## Goal\nvalue.txt says new\n\n## Acceptance criteria\n- file contains new\n`;

/** Fake agent: each call runs the next scripted action in the repo. */
function fakeRunner(actions) {
  const calls = [];
  return {
    calls,
    async run({ prompt, cwd, tier }) {
      calls.push({ tier, prompt });
      const act = actions[Math.min(calls.length - 1, actions.length - 1)];
      const out = act(cwd) ?? "UNGRIND_SUMMARY:\nchanged value";
      return { output: out, exitCode: 0, usage: { costUsd: 0.5, inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}
const write = (rel, text) => (cwd) => { fs.writeFileSync(path.join(cwd, rel), text); };

async function run(dir, config, runner, opts = {}) {
  return runOnce({ config, source: createSource(config), runner, templates: loadTemplates(config.prompts), log: () => {}, ...opts });
}

test("passes first try: commits on loop branch, marks done, writes summary, returns to main", async () => {
  const { dir, config } = makeRepo({ "a": card() });
  const runner = fakeRunner([write("src/value.txt", "new\n")]);
  const r = await run(dir, config, runner);
  assert.equal(r.result, "done");
  assert.equal(r.attempts.length, 1);
  assert.equal(r.startTier, "haiku");
  assert.equal(sh(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(fs.readFileSync(path.join(dir, "src/value.txt"), "utf8"), "old\n"); // main untouched
  assert.equal(sh(dir, "show", "loop/set-value:src/value.txt"), "new");
  assert.deepEqual(sh(dir, "show", "--name-only", "--format=", "loop/set-value").split("\n"), ["src/value.txt"]); // task file not committed
  const taskFile = fs.readFileSync(path.join(dir, "tasks/a.md"), "utf8");
  assert.match(taskFile, /status: Done/);
  assert.match(taskFile, /## Summary[\s\S]*changed value/);
  assert.match(runner.calls[0].prompt, /value\.txt says new/);
  assert.equal(readRunLog(config.prompts.stateDir).length, 1);
});

test("escalates after two failures at a tier, and retry prompt carries verifier output", async () => {
  const { dir, config } = makeRepo({ "a": card() });
  const runner = fakeRunner([write("src/value.txt", "nope1\n"), write("src/value.txt", "nope2\n"), write("src/value.txt", "new\n")]);
  const r = await run(dir, config, runner);
  assert.equal(r.result, "done");
  assert.deepEqual(runner.calls.map((c) => c.tier), ["haiku", "haiku", "sonnet"]);
  assert.match(runner.calls[1].prompt, /This is a retry[\s\S]*value check/);
  assert.match(runner.calls[2].prompt, /Attempt 2 \(haiku\) failed/);
  assert.match(fs.readFileSync(path.join(dir, "tasks/a.md"), "utf8"), /## Notes[\s\S]*Attempt 1/);
});

test("diff guard fails out-of-scope and forbidden changes; max attempts blocks the task", async () => {
  const { dir, config } = makeRepo({ "a": card() });
  const runner = fakeRunner([(cwd) => { write("src/value.txt", "new\n")(cwd); write(".env", "SECRET=1\n")(cwd); write("other.txt", "x")(cwd); }]);
  const r = await run(dir, config, runner);
  assert.equal(r.result, "blocked");
  assert.equal(r.attempts.length, 5);
  assert.deepEqual(r.attempts.map((a) => a.tier), ["haiku", "haiku", "sonnet", "sonnet", "opus"]);
  assert.match(r.attempts[0].failure, /Forbidden paths changed: \.env/);
  assert.match(r.attempts[0].failure, /outside the task's scope.*other\.txt/);
  assert.match(fs.readFileSync(path.join(dir, "tasks/a.md"), "utf8"), /status: Blocked/);
  assert.match(sh(dir, "log", "-1", "--format=%s", "loop/set-value"), /^wip\(blocked\)/);
});

test("cost ceiling stops the run", async () => {
  const { dir, config } = makeRepo({ "a": card() }, { routing: { maxCostUsd: 1 } });
  const r = await run(dir, config, fakeRunner([write("src/value.txt", "bad\n")]));
  assert.equal(r.result, "blocked");
  assert.equal(r.attempts.length, 2);
  assert.match(r.reason, /cost ceiling/);
});

test("invalid cards are blocked with a reason; dependencies and priority order respected", async () => {
  const { dir, config } = makeRepo({
    vague: "---\ntitle: Vague\nstatus: Ready\npriority: 0\n---\nDo stuff\n",
    second: card({ title: "Second", priority: 2, extra: "dependencies: [first]\n" }),
    first: card({ title: "First", priority: 5 }),
  });
  const runner = fakeRunner([write("src/value.txt", "new\n")]);
  const r = await run(dir, config, runner);
  assert.equal(r.task.title, "First");
  assert.equal(r.skipped[0].id, "vague");
  assert.match(fs.readFileSync(path.join(dir, "tasks/vague.md"), "utf8"), /status: Blocked[\s\S]*Failed task contract/);
});

test("agent self-reported block counts as a failed attempt", async () => {
  const { dir, config } = makeRepo({ "a": card() });
  const runner = fakeRunner([() => "UNGRIND_BLOCKED: spec contradicts code", write("src/value.txt", "new\n")]);
  const r = await run(dir, config, runner);
  assert.equal(r.result, "done");
  assert.match(r.attempts[0].failure, /could not proceed: spec contradicts code/);
});

test("human gate skips gated types unless approved", async () => {
  const { dir, config } = makeRepo({ "a": card({ extra: "type: auth\n" }) });
  const r = await run(dir, config, fakeRunner([write("src/value.txt", "new\n")]));
  assert.equal(r.result, "skipped");
  assert.match(fs.readFileSync(path.join(dir, "tasks/a.md"), "utf8"), /status: Blocked/);
});

test("dry run changes no task status and writes no notes", async () => {
  const { dir, config } = makeRepo({ "a": card() });
  const before = fs.readFileSync(path.join(dir, "tasks/a.md"), "utf8");
  const r = await run(dir, config, fakeRunner([write("src/value.txt", "new\n")]), { dryRun: true });
  assert.equal(r.result, "done");
  assert.equal(fs.readFileSync(path.join(dir, "tasks/a.md"), "utf8"), before);
});

test("nothing ready, dirty tree, and missing conventions", async () => {
  const { dir, config } = makeRepo({ "a": card({ status: "Done" }) });
  assert.equal((await run(dir, config, fakeRunner([() => {}]))).result, "nothing-ready");
  fs.writeFileSync(path.join(dir, "src/value.txt"), "dirty\n");
  await assert.rejects(run(dir, config, fakeRunner([() => {}])), /not clean/);
  config.prompts.requireConventions = true;
  await assert.rejects(run(dir, config, fakeRunner([() => {}])), /conventions/);
});
