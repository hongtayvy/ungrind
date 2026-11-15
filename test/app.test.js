import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createSource } from "../src/sources/index.js";
import { buildProjectState, saveCard, initProject, detectVerifier } from "../src/app.js";
import { agentFor, startTier, routeProblems } from "../src/agents/index.js";
import { loadTemplates } from "../src/prompts.js";
import { runOnce } from "../src/engine.js";
import { writeRunLog } from "../src/runlog.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ungrind.js");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-app-")));

test("init writes a starter config with a detected verifier and never overwrites", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const r = initProject(dir);
  assert.equal(r.created, true);
  assert.deepEqual(r.verifier, { name: "tests", command: "npm test --silent" });
  const config = loadConfig(r.configFile);
  assert.equal(config.verifiers[0].command, "npm test --silent");
  assert.ok(fs.existsSync(path.join(dir, "tasks")));
  fs.appendFileSync(r.configFile, "# mine\n");
  assert.equal(initProject(dir).created, false);
  assert.match(fs.readFileSync(r.configFile, "utf8"), /# mine/);
  const bare = tmp();
  assert.equal(detectVerifier(bare), null);
  assert.equal(loadConfig(initProject(bare).configFile).verifiers[0].command, "true");
});

test("card-save creates, updates, and preserves engine sections and unknown properties", async () => {
  const dir = tmp();
  const config = loadConfig(initProject(dir).configFile);
  const made = saveCard(config, { title: "Add: export \"CSV\"", goal: "Users can export.", criteria: ["button exists", " "], files: ["src/export.js"], status: "ready", priority: 2, size: "small" });
  assert.equal(made.id, "add-export-csv");
  assert.equal(saveCard(config, { title: "Add export CSV", goal: "g", criteria: ["c"], files: ["a"] }).id, "add-export-csv-2");

  fs.appendFileSync(made.file, "\n## Notes\n\n_2026_\n\nAttempt 1 failed.\n");
  fs.writeFileSync(made.file, fs.readFileSync(made.file, "utf8").replace("---\n", "---\naliases: [exp]\n"));
  saveCard(config, { id: made.id, title: "Add CSV export", goal: "New goal.", criteria: ["one", "two"], files: ["src/export.js", "test/export.test.js"], status: "blocked", priority: 1, tier: "sonnet", agent: "codex", archived: true });
  const text = fs.readFileSync(made.file, "utf8");
  assert.match(text, /aliases: \["exp"\]/);
  assert.match(text, /status: Blocked/);
  assert.doesNotMatch(text, /size:/);
  assert.match(text, /## Goal\nNew goal\.\n\n## Acceptance criteria\n- one\n- two\n\n## Notes\n\n_2026_\n\nAttempt 1 failed\./);

  const state = await buildProjectState(config, createSource(config));
  const card = state.cards.find((c) => c.id === made.id);
  assert.equal(card.title, "Add CSV export");
  assert.deepEqual(card.files, ["src/export.js", "test/export.test.js"]);
  assert.deepEqual([card.status, card.archived, card.tier, card.agent], ["blocked", true, "sonnet", "codex"]);
  assert.deepEqual(card.route, { startTier: "sonnet", agent: "codex", model: null, overridden: true });
  assert.match(card.notes, /Attempt 1 failed/);
  assert.throws(() => saveCard(config, { id: "nope", title: "x" }), /No card with id nope/);
  assert.throws(() => saveCard(config, { title: " " }), /needs a title/);
});

test("state reports rules, route, problems, and runs", async () => {
  const dir = tmp();
  const config = loadConfig(initProject(dir).configFile);
  saveCard(config, { title: "Good", goal: "g", criteria: ["c"], files: ["a.js"], size: "small" });
  saveCard(config, { title: "Bad route", goal: "g", criteria: ["c"], files: ["a.js"], tier: "turbo", agent: "gemini" });
  saveCard(config, { title: "Pay", goal: "g", criteria: ["c"], files: ["a.js"], type: "payments" });
  writeRunLog(config.prompts.stateDir, { ts: "2026-11-15T10:00:00Z", task: { id: "good", title: "Good" }, result: "done", branch: "loop/good", pushed: true, totalCostUsd: 0.01, durationMs: 9000, attempts: [{ tier: "haiku", agent: "claude-code", passed: true }] });
  writeRunLog(config.prompts.stateDir, { ts: "2026-11-15T11:00:00Z", task: null, result: "nothing-ready", attempts: [] });
  const s = await buildProjectState(config, createSource(config));
  assert.deepEqual(s.rules.ladder, ["haiku", "sonnet", "opus"]);
  assert.equal(s.rules.verifiers[0].command, "true");
  assert.equal(s.conventionsApproved, false);
  const by = Object.fromEntries(s.cards.map((c) => [c.id, c]));
  assert.deepEqual(by.good.route, { startTier: "haiku", agent: "claude-code", model: "claude-haiku-5-5", overridden: false });
  assert.deepEqual(by.good.problems, []);
  assert.equal(by["bad-route"].problems.length, 2);
  assert.equal(by.pay.needsApproval, true);
  assert.deepEqual(s.runs.map((r) => [r.taskId, r.result, r.path, r.pushed]), [["good", "done", "haiku✓", true]]);
});

test("card overrides drive routing; archived cards never run; bad overrides block", async () => {
  const dir = tmp();
  const config = loadConfig(initProject(dir).configFile);
  config.prompts.requireConventions = false;
  config.guardrails.push = false;
  config.verifiers[0].command = "grep -q new v.txt";
  fs.writeFileSync(path.join(dir, "v.txt"), "old\n");
  saveCard(config, { title: "Archived", goal: "g", criteria: ["c"], files: ["v.txt"], priority: 0, archived: true });
  saveCard(config, { title: "Broken", goal: "g", criteria: ["c"], files: ["v.txt"], priority: 1, tier: "turbo" });
  saveCard(config, { title: "Straight to codex", goal: "g", criteria: ["c"], files: ["v.txt"], priority: 2, size: "small", tier: "opus", agent: "codex" });
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"], { cwd: dir });
  const t = { size: "small", tier: "opus", agent: "codex" };
  assert.equal(startTier(config, t), "opus");
  assert.equal(agentFor(config, t, "opus"), "codex");
  assert.deepEqual(routeProblems(config, { agent: "ollama" }), ["agent ollama has no models in agent.ollama.models"]);
  const calls = [];
  const fake = (name) => ({ async run({ cwd, tier }) { calls.push([name, tier]); fs.writeFileSync(path.join(cwd, "v.txt"), "new\n"); return { output: "UNGRIND_SUMMARY: ok", exitCode: 0, usage: { costUsd: 0 }, durationMs: 1 }; } });
  const r = await runOnce({ config, source: createSource(config), runners: { get: (a) => fake(a) }, templates: loadTemplates(config.prompts), log: () => {} });
  assert.equal(r.task.title, "Straight to codex");
  assert.deepEqual(calls, [["codex", "opus"]]);
  assert.deepEqual(r.skipped.map((s) => s.id), ["broken"]);
  assert.match(r.skipped[0].reason, /tier "turbo" is not on the ladder/);
  assert.match(fs.readFileSync(path.join(dir, "tasks/archived.md"), "utf8"), /status: Ready/);
});

test("CLI: init, card-save over stdin, and state print JSON", () => {
  const dir = tmp();
  const init = JSON.parse(execFileSync("node", [BIN, "init", "--dir", dir], { encoding: "utf8" }));
  assert.equal(init.created, true);
  assert.equal(JSON.parse(execFileSync("node", [BIN, "find-config", "--dir", dir], { encoding: "utf8" })).configFile, init.configFile);
  const saved = JSON.parse(execFileSync("node", [BIN, "card-save", "--config", init.configFile], { encoding: "utf8", input: JSON.stringify({ title: "From app", goal: "g", criteria: ["c"], files: ["x"] }) }));
  assert.equal(saved.id, "from-app");
  const state = JSON.parse(execFileSync("node", [BIN, "state", "--config", init.configFile], { encoding: "utf8" }));
  assert.equal(state.cards[0].title, "From app");
  assert.equal(state.repo, dir);
});
