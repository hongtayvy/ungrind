import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateConfig } from "../src/config.js";
import { createRunners } from "../src/agents/index.js";
import { createSource } from "../src/sources/index.js";
import { loadTemplates } from "../src/prompts.js";
import { runOnce } from "../src/engine.js";
import { diffText, parseVerdict } from "../src/review.js";

function setup(review) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-review-"));
  fs.mkdirSync(path.join(dir, "tasks"));
  fs.writeFileSync(path.join(dir, "v.txt"), "old\n");
  fs.writeFileSync(path.join(dir, "tasks/a.md"), "---\ntitle: Set v\nstatus: Ready\npriority: 1\nsize: small\nfiles: [v.txt, new.txt]\n---\n## Goal\nv is new\n## Acceptance criteria\n- v is new\n");
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"], { cwd: dir });
  const { config, errors } = validateConfig({
    project: "r", repo: dir, taskSource: { adapter: "local" },
    verifiers: [{ name: "v", command: "grep -q '^new$' v.txt" }],
    guardrails: { push: false }, prompts: { requireConventions: false }, review,
  });
  assert.deepEqual(errors, []);
  return { dir, config };
}

const builder = (calls) => ({
  async run({ cwd, prompt }) {
    calls.push(["build", prompt]);
    fs.writeFileSync(path.join(cwd, "v.txt"), "new\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "added\n");
    return { output: "UNGRIND_SUMMARY: set v", exitCode: 0, usage: { costUsd: 0.1 }, durationMs: 1 };
  },
});
const reviewer = (calls, verdicts) => ({
  async run({ prompt, readOnly, model }) {
    calls.push(["review", prompt, readOnly, model]);
    return { output: verdicts[Math.min(calls.filter((c) => c[0] === "review").length - 1, verdicts.length - 1)], exitCode: 0, usage: { costUsd: 0.05 }, durationMs: 1 };
  },
});
const go = (config, runners) => runOnce({ config, source: createSource(config), runners, templates: loadTemplates(config.prompts), log: () => {} });

test("verdict parsing", () => {
  assert.deepEqual(parseVerdict("looks fine\nUNGRIND_REVIEW: PASS"), { verdict: "PASS", issues: "" });
  assert.deepEqual(parseVerdict("UNGRIND_REVIEW: FAIL\n- v.txt: off by one"), { verdict: "FAIL", issues: "- v.txt: off by one" });
  assert.equal(parseVerdict("no marker").verdict, null);
});

test("diffText includes tracked diffs and untracked files", () => {
  const { dir } = setup();
  fs.writeFileSync(path.join(dir, "v.txt"), "new\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "added\n");
  const d = diffText(dir, ["new.txt", "v.txt"]);
  assert.match(d, /-old\n\+new/);
  assert.match(d, /\+\+\+ b\/new\.txt\n\+added/);
  assert.match(diffText(dir, ["v.txt"], 10), /truncated at 10 chars/);
});

test("blocking review FAIL feeds issues into the retry; PASS completes", async () => {
  const { config } = setup({ agent: "codex", model: "rev-model" });
  const calls = [];
  const runners = createRunners(config, { "claude-code": builder(calls), codex: reviewer(calls, ["UNGRIND_REVIEW: FAIL\n- new.txt is not needed", "UNGRIND_REVIEW: PASS"]) });
  const r = await go(config, runners);
  assert.equal(r.result, "done");
  assert.deepEqual(calls.map((c) => c[0]), ["build", "review", "build", "review"]);
  assert.equal(calls[1][2], true); // reviewer is read-only
  assert.equal(calls[1][3], "rev-model");
  assert.match(calls[1][1], /```diff[\s\S]*\+new/);
  assert.match(calls[2][1], /Cross-vendor review by codex failed:\n- new\.txt is not needed/);
  assert.deepEqual(r.attempts.map((a) => a.review.verdict), ["FAIL", "PASS"]);
  assert.equal(r.attempts[0].review.crossVendor, true);
  assert.equal(Math.round(r.totalCostUsd * 100), 30); // 2 builds + 2 reviews
});

test("non-blocking review records issues in the summary but does not fail", async () => {
  const { dir, config } = setup({ agent: "codex", blocking: false });
  const calls = [];
  const r = await go(config, createRunners(config, { "claude-code": builder(calls), codex: reviewer(calls, ["UNGRIND_REVIEW: FAIL\n- nit"]) }));
  assert.equal(r.result, "done");
  assert.equal(r.attempts.length, 1);
  assert.match(fs.readFileSync(path.join(dir, "tasks/a.md"), "utf8"), /## Summary[\s\S]*Non-blocking review by codex failed:\n- nit/);
});

test("blocking review with no verdict counts as a failure", async () => {
  const { config } = setup({ agent: "codex" });
  config.guardrails.maxAttempts = 1;
  const calls = [];
  const r = await go(config, createRunners(config, { "claude-code": builder(calls), codex: reviewer(calls, ["I am not sure."]) }));
  assert.equal(r.result, "blocked");
  assert.match(r.attempts[0].failure, /gave no verdict/);
});

test("review config validation", () => {
  const base = { project: "p", taskSource: { adapter: "local" }, verifiers: [{ name: "t", command: "true" }] };
  assert.equal(validateConfig(base).config.review.enabled, false);
  assert.match(validateConfig({ ...base, review: { agent: "ollama" } }).errors.join(), /review\.model: required/);
  assert.match(validateConfig({ ...base, review: { agent: "gemini" } }).errors.join(), /unknown adapter "gemini"/);
});
