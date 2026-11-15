import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, stringifyYaml } from "../src/yaml.js";
import { loadConfig } from "../src/config.js";
import { initProject } from "../src/app.js";
import { getRules, saveRules } from "../src/rules.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-rules-")));
const noOllama = { fetch: async () => { throw new Error("down"); } };

test("stringifyYaml round-trips through parseYaml", () => {
  const obj = {
    project: "demo", repo: ".", tricky: "yes", num: 3, flag: false, nothing: null, text: "a: b # c", spaced: "plain words here",
    list: ["a", "b, c", ".env.*"], empty: [], emptyMap: {},
    nested: { deep: { x: 1, pattern: "loop/{slug}" }, sizes: { small: "haiku" } },
    verifiers: [{ name: "unit tests", command: "npm test --silent", timeoutSec: 120, pass: { exitCode: 0 } }, { name: "lint", command: "echo '#x'" }],
  };
  assert.deepEqual(parseYaml(stringifyYaml(obj)), obj);
  for (const f of ["examples/demo/ungrind.config.yaml", "examples/demo/ungrind.local.yaml"]) {
    const raw = parseYaml(fs.readFileSync(path.join(ROOT, f), "utf8"));
    assert.deepEqual(parseYaml(stringifyYaml(raw)), raw, f);
  }
});

test("getRules returns editable rules, defaults, and tolerates Ollama being down", async () => {
  const dir = tmp();
  const config = loadConfig(initProject(dir).configFile);
  const r = await getRules(config, noOllama);
  assert.deepEqual(r.rules.ladder, ["haiku", "sonnet", "opus"]);
  assert.deepEqual(r.rules.verifiers, [{ name: "placeholder", command: "true", timeoutSec: 600 }]);
  assert.equal(r.rules.review.enabled, false);
  assert.equal(r.defaults.maxAttempts, 6);
  assert.deepEqual(r.installedLocalModels, []);
  const withModels = await getRules(config, { fetch: async () => ({ ok: true, json: async () => ({ models: [{ name: "qwen:latest" }] }) }) });
  assert.deepEqual(withModels.installedLocalModels, ["qwen:latest"]);
});

test("saveRules merges edits, keeps unknown keys and the top comment, and backs up", async () => {
  const dir = tmp();
  const file = initProject(dir).configFile;
  fs.appendFileSync(file, "\ncron:\n  dailyUsd: 4\nagent:\n  byType: { ui: codex }\n");
  const before = fs.readFileSync(file, "utf8");
  const { rules } = await getRules(loadConfig(file), noOllama);

  const edited = {
    ...rules,
    verifiers: [{ name: "tests", command: "npm test", timeoutSec: 90 }, { name: "lint", command: "npm run lint", timeoutSec: 60 }],
    forbiddenPaths: [".env", "infra/**"], maxAttempts: 4, maxCostUsd: 2.5, push: false,
    ladder: ["local", "haiku", "sonnet"], tierBySize: { small: "local", medium: "haiku", large: "sonnet" }, defaultTier: "haiku",
    localModel: "qwen:latest", humanApprovalTypes: ["auth"], review: { enabled: true, agent: "codex", blocking: false },
  };
  const res = saveRules(file, edited);
  assert.equal(res.saved, true);
  assert.equal(fs.readFileSync(res.backup, "utf8"), before);

  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# Ungrind rules for this folder/);
  const c = loadConfig(file);
  assert.deepEqual(c.verifiers.map((v) => [v.name, v.command, v.timeoutSec]), [["tests", "npm test", 90], ["lint", "npm run lint", 60]]);
  assert.deepEqual(c.guardrails.forbiddenPaths, [".env", "infra/**"]);
  assert.deepEqual([c.guardrails.maxAttempts, c.guardrails.push, c.routing.maxCostUsd], [4, false, 2.5]);
  assert.deepEqual(c.routing.ladder, ["local", "haiku", "sonnet"]);
  assert.equal(c.agent.byTier.local, "ollama");
  assert.equal(c.agent.ollama.models.local, "qwen:latest");
  assert.deepEqual(c.agent.byType, { ui: "codex" }); // untouched by the editor
  assert.equal(c.cron.dailyUsd, 4);
  assert.deepEqual([c.review.enabled, c.review.agent, c.review.blocking], [true, "codex", false]);
  assert.deepEqual(c.gates.humanApprovalTypes, ["auth"]);

  // Turning local and review back off removes them cleanly.
  const again = (await getRules(c, noOllama)).rules;
  saveRules(file, { ...again, ladder: ["haiku", "sonnet"], tierBySize: { small: "haiku", medium: "haiku", large: "sonnet" }, review: { ...again.review, enabled: false } });
  const c2 = loadConfig(file);
  assert.deepEqual(c2.agent.byTier, {});
  assert.equal(c2.review.enabled, false);
});

test("saveRules refuses invalid rules and leaves the file alone", async () => {
  const dir = tmp();
  const file = initProject(dir).configFile;
  const before = fs.readFileSync(file, "utf8");
  const { rules } = await getRules(loadConfig(file), noOllama);
  assert.throws(() => saveRules(file, { ...rules, verifiers: [] }), /nothing was saved[\s\S]*at least one check/);
  assert.throws(() => saveRules(file, { ...rules, ladder: ["local", "haiku", "sonnet", "opus"], localModel: null }), /runs on ollama but has no model/);
  assert.throws(() => saveRules(file, { ...rules, ladder: ["sonnet", "opus"] }), /"haiku" is not on the ladder/);
  assert.throws(() => saveRules(file, { ...rules, branchPattern: "loop" }), /\{slug\}/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
