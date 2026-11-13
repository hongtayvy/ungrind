import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateConfig } from "../src/config.js";
import { createSource } from "../src/sources/index.js";
import { loadTemplates } from "../src/prompts.js";
import { usageSoFar, precheck, acquireLock, cronRun, crontabLine } from "../src/cron.js";
import { writeRunLog, readRunLog } from "../src/runlog.js";

function setup(cron = {}, tasks = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-cron-"));
  fs.mkdirSync(path.join(dir, "tasks"));
  for (let i = 1; i <= tasks; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), "old\n");
    fs.writeFileSync(path.join(dir, "tasks", `t${i}.md`), `---\ntitle: Task ${i}\nstatus: Ready\npriority: ${i}\nfiles: [f${i}.txt]\n---\n## Goal\ng\n## Acceptance criteria\n- c\n`);
  }
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"], { cwd: dir });
  const { config, errors } = validateConfig({
    project: "c", repo: dir, taskSource: { adapter: "local" },
    verifiers: [{ name: "changed", command: "! grep -l '^old$' $(git diff --name-only HEAD) 2>/dev/null" }],
    guardrails: { push: false }, prompts: { requireConventions: false }, cron,
  });
  assert.deepEqual(errors, []);
  config.file = path.join(dir, "ungrind.config.yaml");
  return { dir, config };
}

const editRunner = {
  async run({ prompt, cwd }) {
    const file = prompt.match(/- (f\d+\.txt)/)[1];
    fs.writeFileSync(path.join(cwd, file), "new\n");
    return { output: "UNGRIND_SUMMARY: ok", exitCode: 0, usage: { costUsd: 1 }, durationMs: 1 };
  },
};

const go = (config, extra = {}) =>
  cronRun({ config, source: createSource(config), runner: editRunner, templates: loadTemplates(config.prompts), log: () => {}, ...extra });

test("usageSoFar counts today and the rolling week, ignoring dry runs", () => {
  const now = new Date("2026-11-13T12:00:00");
  const u = usageSoFar([
    { ts: "2026-11-13T09:00:00", totalCostUsd: 1, attempts: [{}] },
    { ts: "2026-11-13T10:00:00", totalCostUsd: 5, attempts: [{}], dryRun: true },
    { ts: "2026-11-10T10:00:00", totalCostUsd: 2, attempts: [{}] },
    { ts: "2026-10-01T10:00:00", totalCostUsd: 50, attempts: [{}] },
  ], now);
  assert.deepEqual(u, { todayUsd: 1, weekUsd: 3, runsToday: 1 });
});

test("cron runs up to maxTasksPerRun tasks in sequence", async () => {
  const { config } = setup({ maxTasksPerRun: 5 });
  const results = await go(config);
  assert.deepEqual(results.map((r) => r.result), ["done", "done", "nothing-ready"]);
  assert.equal(fs.existsSync(path.join(config.prompts.stateDir, "cron.lock")), false);
});

test("daily budget skips the run and notifies 'skipped'", async () => {
  const { config } = setup({ maxTasksPerRun: 5, dailyUsd: 1 });
  const sent = [];
  const results = await go(config, { notify: async (e, r) => sent.push([e, r.result]) });
  assert.deepEqual(results.map((r) => r.result), ["done", "skipped-usage"]);
  assert.match(results[1].reason, /daily budget reached/);
  assert.deepEqual(sent, [["done", "done"], ["skipped", "skipped-usage"]]);
  assert.equal(readRunLog(config.prompts.stateDir).at(-1).result, "skipped-usage");
});

test("precheck command and run limits", () => {
  const { config } = setup({ precheckCommand: "exit 3", maxRunsPerDay: 1 });
  assert.match(precheck(config, { exec: () => ({ status: 3, output: "usage at 92%\n" }) }).reason, /exit 3\): usage at 92%/);
  assert.equal(precheck(config, { exec: () => ({ status: 0, output: "" }) }).ok, true);
  writeRunLog(config.prompts.stateDir, { ts: new Date().toISOString(), totalCostUsd: 0, attempts: [{}] });
  assert.match(precheck(config, { exec: () => ({ status: 0, output: "" }) }).reason, /max runs per day/);
});

test("lock blocks a second live run and recovers from a dead one", async () => {
  const { config } = setup();
  const lockFile = path.join(config.prompts.stateDir, "cron.lock");
  fs.mkdirSync(config.prompts.stateDir, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, ts: new Date().toISOString() }));
  assert.deepEqual((await go(config)).map((r) => r.result), ["locked"]);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const release = acquireLock(config.prompts.stateDir, 180);
  assert.ok(release);
  release();
});

test("engine errors are logged and alert as blocked", async () => {
  const { dir, config } = setup();
  fs.writeFileSync(path.join(dir, "f1.txt"), "dirty\n");
  const sent = [];
  const results = await go(config, { notify: async (e, r) => sent.push(e) });
  assert.equal(results[0].result, "error");
  assert.match(results[0].reason, /not clean/);
  assert.deepEqual(sent, ["blocked"]);
});

test("crontab line uses absolute paths and logs to the state dir", () => {
  const { config } = setup();
  const line = crontabLine(config, { schedule: "0 * * * *", node: "/usr/bin/node", bin: "/opt/ungrind/bin/ungrind.js", pathEnv: "/usr/bin" });
  assert.match(line, /^0 \* \* \* \* cd '.*' && PATH='\/usr\/bin' '\/usr\/bin\/node' '\/opt\/ungrind\/bin\/ungrind\.js' cron --config '.*ungrind\.config\.yaml' >> '.*cron\.log' 2>&1$/);
});
