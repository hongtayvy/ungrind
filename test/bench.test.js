import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSuite, runBench, compareBench, formatComparison } from "../src/bench.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Copy the shipped suite so results.jsonl lands in a temp dir. */
function suiteCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-suite-"));
  fs.cpSync(path.join(ROOT, "benchmarks/strings"), dir, { recursive: true });
  fs.rmSync(path.join(dir, "results.jsonl"), { force: true });
  return loadSuite(path.join(dir, "suite.yaml"));
}

// Solves slugify and title case; never solves truncate.
const solver = {
  async run({ prompt, cwd }) {
    const f = path.join(cwd, "src/strings.js");
    if (/Add slugify helper/.test(prompt)) fs.appendFileSync(f, `\nexport const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n`);
    else if (/Fix titleCase/.test(prompt)) fs.appendFileSync(f, "\n// fixed\n");
    else fs.appendFileSync(f, "\n// still broken\n");
    return { output: "UNGRIND_SUMMARY: ok", exitCode: 0, usage: { costUsd: 0.01 }, durationMs: 1 };
  },
};

test("suite loads and validates", () => {
  const s = loadSuite(path.join(ROOT, "benchmarks/strings/suite.yaml"));
  assert.deepEqual(s.cases, ["slugify", "truncate", "fix-title-case"]);
  assert.ok(fs.existsSync(path.join(s.fixture, "tasks/truncate.md")));
});

test("bench runs each case in a fresh fixture copy and logs a comparable summary", async () => {
  const suite = suiteCopy();
  // Replace the fixture's verifier with one the fake solver can satisfy deterministically.
  const cfgFile = path.join(suite.fixture, "ungrind.config.yaml");
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, "utf8").replace("command: npm test --silent", `command: "! grep -q 'still broken' src/strings.js"`).replace("maxAttempts: 6", "maxAttempts: 2"));
  const logs = [];
  const r = await runBench(suite, { runnerDeps: { "claude-code": solver }, log: (m) => logs.push(m) });
  assert.equal(r.runs, 3);
  assert.equal(r.passed, 2);
  assert.equal(r.firstTry, 2);
  assert.deepEqual(r.cases.map((c) => [c.case, c.result]), [["slugify", "done"], ["truncate", "blocked"], ["fix-title-case", "done"]]);
  assert.match(r.promptVersion, /^v1\+[0-9a-f]{8}$/);
  assert.deepEqual(r.ladder, ["haiku", "sonnet", "opus"]);
  assert.equal(logs.length, 3);
  // The shipped fixture itself is untouched (each case ran in a temp copy).
  assert.doesNotMatch(fs.readFileSync(path.join(suite.fixture, "src/strings.js"), "utf8"), /slugify|fixed/);

  await runBench(suite, { runnerDeps: { "claude-code": solver }, log: () => {} });
  const rows = compareBench(suite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].benchRuns, 2);
  assert.equal(rows[0].runs, 6);
  assert.match(formatComparison(rows), /2 bench run\(s\), 6 task run\(s\): pass 67%, first-try 67%/);
});

test("a case id missing from the fixture is reported, not silently passed", async () => {
  const suite = { ...suiteCopy(), cases: ["does-not-exist"] };
  const r = await runBench(suite, { runnerDeps: { "claude-code": solver }, log: () => {} });
  assert.equal(r.cases[0].result, "missing-task");
  assert.equal(r.passed, 0);
});
