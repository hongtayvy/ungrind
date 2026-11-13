import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateConfig } from "../src/config.js";
import { loadTemplates } from "../src/prompts.js";
import { singleRunner } from "../src/agents/index.js";
import { writeRunLog, passRateByPromptVersion } from "../src/runlog.js";
import { categorize, gatherEvidence, formatEvidence, propose, listProposals, accept, reject, extractAddition } from "../src/proposals.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-prop-"));
  const { config, errors } = validateConfig({ project: "p", repo: dir, taskSource: { adapter: "local" }, verifiers: [{ name: "unit tests", command: "npm test" }] });
  assert.deepEqual(errors, []);
  return config;
}

const failRun = (ts, failures, extra = {}) => ({
  ts, task: { title: "T" }, result: "blocked", totalCostUsd: 0,
  attempts: failures.map((f, i) => ({ tier: i < 2 ? "local" : "haiku", agent: i < 2 ? "ollama" : "claude-code", passed: false, failure: f })),
  ...extra,
});

const DRAFT = `## Problem
Agents forget to export new helpers.

## Proposed addition to conventions
\`\`\`markdown
- Every helper in src/strings.js must be a named export; tests import from "../src/strings.js".
\`\`\`

## Expected effect
Prevents the 3 "is not a function" test failures.

## Note for the human
(none)`;

test("categorize groups failures by cause", () => {
  assert.equal(categorize('Check "unit tests" failed:\nTypeError'), "check failed: unit tests");
  assert.equal(categorize('Check "diff-guard" failed:\nFiles outside the task\'s scope (a): b'), "diff guard: out of scope");
  assert.equal(categorize('Check "diff-guard" failed:\nForbidden paths changed: .env'), "diff guard: forbidden path");
  assert.equal(categorize("Cross-vendor review by codex failed:\n- x"), "review rejected the change");
  assert.equal(categorize("Agent run failed (exit 124, timed out):\n"), "agent timed out");
  assert.equal(categorize("Agent reported it could not proceed: unclear"), "agent said blocked");
});

test("evidence is gathered from real runs only, newest-proposal cutoff applies", () => {
  const recs = [
    failRun("2026-11-01T00:00:00Z", ['Check "unit tests" failed:\nslugify is not a function', 'Check "unit tests" failed:\nslugify is not a function', "Agent reported it could not proceed: x"]),
    failRun("2026-11-02T00:00:00Z", ['Check "unit tests" failed:\nboom'], { dryRun: true }),
    failRun("2026-11-03T00:00:00Z", ['Check "unit tests" failed:\ntruncate is not a function']),
  ];
  const ev = gatherEvidence(recs);
  assert.equal(ev.runs, 2);
  assert.equal(ev.failedAttempts, 4);
  assert.deepEqual(ev.groups.map((g) => [g.category, g.count]), [["check failed: unit tests", 3], ["agent said blocked", 1]]);
  assert.deepEqual(ev.groups[0].tiers, { local: 3 });
  assert.match(formatEvidence(ev), /### check failed: unit tests: 3 time\(s\) \(local ×3\)[\s\S]*slugify is not a function/);
  assert.equal(gatherEvidence(recs, { since: "2026-11-01T12:00:00Z" }).failedAttempts, 1);
});

test("propose → accept appends to conventions only after human approval", async () => {
  const config = setup();
  const templates = { ...loadTemplates(config.prompts), propose: "{{evidence}}\n{{conventions}}\n{{checks}}" };
  const prompts = [];
  const runner = { async run({ prompt, readOnly }) { prompts.push({ prompt, readOnly }); return { output: DRAFT, exitCode: 0, usage: { costUsd: 0 }, durationMs: 1 }; } };
  const logs = [];
  const log = (m) => logs.push(m);

  // Not enough evidence yet: no model call, nothing written.
  writeRunLog(config.prompts.stateDir, failRun("2026-11-01T00:00:00Z", ['Check "unit tests" failed:\nx']));
  assert.equal(await propose({ config, runners: singleRunner(runner), templates, log }), null);
  assert.equal(prompts.length, 0);
  assert.match(logs.at(-1), /not enough new evidence: 1 failed attempt/);

  writeRunLog(config.prompts.stateDir, failRun("2026-11-02T00:00:00Z", ['Check "unit tests" failed:\nslugify is not a function', 'Check "unit tests" failed:\nslugify is not a function']));
  const p = await propose({ config, runners: singleRunner(runner), templates, log, now: new Date("2026-11-13T10:20:30Z") });
  assert.equal(p.id, "20261113-102030");
  assert.equal(prompts[0].readOnly, true);
  assert.match(prompts[0].prompt, /3 failed attempt\(s\) across 2 run\(s\)/);
  const text = fs.readFileSync(p.file, "utf8");
  assert.match(text, /^---\nstatus: pending/);
  assert.match(text, /## Evidence \(from the run log, written by the engine\)/);
  assert.deepEqual(listProposals(config).map((x) => [x.id, x.status, x.problem]), [["20261113-102030", "pending", "Agents forget to export new helpers."]]);

  // Accept needs an approved conventions file.
  assert.throws(() => accept({ config, id: p.id, log }), /No approved conventions/);
  fs.writeFileSync(config.prompts.conventions, "## Stack\nNode\n");
  accept({ config, id: p.id, log, now: new Date("2026-11-13T11:00:00Z") });
  const conv = fs.readFileSync(config.prompts.conventions, "utf8");
  assert.match(conv, /## Learned from runs \(proposal 20261113-102030, 2026-11-13\)\n- Every helper in src\/strings\.js must be a named export/);
  assert.equal(listProposals(config)[0].status, "accepted");
  assert.throws(() => accept({ config, id: p.id, log }), /already accepted/);
  assert.match(fs.readFileSync(path.join(config.prompts.stateDir, "approvals.jsonl"), "utf8"), /"proposal":"20261113-102030"/);

  // Evidence already used is not proposed again.
  assert.equal(await propose({ config, runners: singleRunner(runner), templates, log }), null);
});

test("reject leaves conventions untouched; malformed drafts are refused", async () => {
  const config = setup();
  fs.mkdirSync(path.join(config.prompts.stateDir, "proposals"), { recursive: true });
  fs.writeFileSync(path.join(config.prompts.stateDir, "proposals", "x1.md"), `---\nstatus: pending\ncreated: "2026-11-01T00:00:00Z"\n---\n${DRAFT}\n`);
  reject({ config, id: "x1", log: () => {} });
  assert.equal(listProposals(config)[0].status, "rejected");
  assert.equal(fs.existsSync(config.prompts.conventions), false);

  for (let i = 0; i < 3; i++) writeRunLog(config.prompts.stateDir, failRun(`2026-11-0${i + 2}T00:00:00Z`, ['Check "unit tests" failed:\nx']));
  const bad = { async run() { return { output: "Sure! Here are some ideas.", exitCode: 0, usage: { costUsd: 0 }, durationMs: 1 }; } };
  const templates = { ...loadTemplates(config.prompts), propose: "{{evidence}}{{conventions}}{{checks}}" };
  await assert.rejects(propose({ config, runners: singleRunner(bad), templates, log: () => {} }), /wrong format/);
  assert.equal(extractAddition("## Proposed addition to conventions\n- plain text\n## Next"), "- plain text");
});

test("stats separate runs by conventions version", () => {
  const rows = passRateByPromptVersion([
    { promptVersion: "v1+a", conventionsVersion: "c1", result: "done", attempts: [{}] },
    { promptVersion: "v1+a", conventionsVersion: "c2", result: "done", attempts: [{}] },
  ]);
  assert.deepEqual(Object.keys(rows), ["v1+a conv:c1", "v1+a conv:c2"]);
});
