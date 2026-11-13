import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseYaml } from "./yaml.js";
import { loadConfig } from "./config.js";
import { createSource } from "./sources/index.js";
import { createRunners } from "./agents/index.js";
import { loadTemplates } from "./prompts.js";
import { runOnce } from "./engine.js";

/**
 * Benchmark set: a fixed suite of tasks rerun whenever a prompt changes, like a regression suite.
 * suite.yaml:
 *   name: strings
 *   fixture: fixture               # repo template (with tasks/ and a config), relative to the suite file
 *   config: ungrind.config.yaml    # config file inside the fixture
 *   repeat: 1
 *   cases: [task-id, ...]
 * Each case runs in a fresh temp git copy of the fixture (no push, no conventions gate),
 * so results depend only on the prompts, models, and agents.
 * Results append to <suite dir>/results.jsonl, one line per benchmark run.
 */

export function loadSuite(file) {
  const abs = path.resolve(file);
  const s = parseYaml(fs.readFileSync(abs, "utf8"));
  const errors = [];
  if (!s.name) errors.push("name: required");
  if (!Array.isArray(s.cases) || !s.cases.length) errors.push("cases: at least one task id required");
  const fixture = path.resolve(path.dirname(abs), s.fixture ?? "fixture");
  if (!fs.existsSync(fixture)) errors.push(`fixture not found: ${fixture}`);
  if (errors.length) throw new Error(`Invalid suite ${abs}:\n  - ${errors.join("\n  - ")}`);
  return { file: abs, dir: path.dirname(abs), name: s.name, fixture, config: s.config ?? "ungrind.config.yaml", repeat: s.repeat ?? 1, cases: s.cases.map(String) };
}

function materialize(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-bench-"));
  fs.cpSync(fixture, dir, { recursive: true });
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=ungrind -c user.email=ungrind@localhost commit -qm fixture"], { cwd: dir });
  return dir;
}

/** opts: { fixtureConfig, promptsDir, promptsVersion, runnerDeps, log, keep } */
export async function runBench(suite, opts = {}) {
  const log = opts.log ?? console.log;
  const configName = opts.fixtureConfig ?? suite.config;
  const cases = [];
  let promptVersion = null, ladder = null;
  for (let rep = 1; rep <= suite.repeat; rep++) {
    for (const id of suite.cases) {
      const dir = materialize(suite.fixture);
      try {
        const config = loadConfig(path.join(dir, configName));
        if (opts.promptsDir) config.prompts.dir = path.resolve(opts.promptsDir);
        if (opts.promptsVersion) config.prompts.version = opts.promptsVersion;
        config.prompts.requireConventions = false;
        config.guardrails.push = false;
        const templates = loadTemplates(config.prompts);
        promptVersion = templates.version;
        ladder = config.routing.ladder;
        const r = await runOnce({
          config, source: createSource(config), runners: createRunners(config, opts.runnerDeps ?? {}),
          templates, onlyId: id, skipConventions: true, log: opts.verbose ? log : () => {},
        });
        const row = {
          case: id, rep, result: r.result, attempts: r.attempts.length, firstTry: r.result === "done" && r.attempts.length === 1,
          tiers: r.attempts.map((a) => a.tier), costUsd: r.totalCostUsd, durationMs: r.durationMs,
        };
        if (r.result === "nothing-ready") row.result = "missing-task";
        cases.push(row);
        log(`[bench] ${id}#${rep}: ${row.result} in ${row.attempts} attempt(s) [${row.tiers.join(" → ")}] $${row.costUsd.toFixed(3)}`);
      } catch (e) {
        cases.push({ case: id, rep, result: "error", error: e.message, attempts: 0, firstTry: false, tiers: [], costUsd: 0, durationMs: 0 });
        log(`[bench] ${id}#${rep}: error: ${e.message}`);
      } finally {
        if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  const n = cases.length;
  const summary = {
    ts: new Date().toISOString(), suite: suite.name, fixtureConfig: configName, promptVersion, ladder,
    runs: n, passed: cases.filter((c) => c.result === "done").length, firstTry: cases.filter((c) => c.firstTry).length,
    costUsd: cases.reduce((s, c) => s + c.costUsd, 0), durationMs: cases.reduce((s, c) => s + c.durationMs, 0), cases,
  };
  fs.appendFileSync(path.join(suite.dir, "results.jsonl"), `${JSON.stringify(summary)}\n`);
  return summary;
}

/** Aggregate all logged benchmark runs per (prompt version, fixture config). */
export function compareBench(suite) {
  const f = path.join(suite.dir, "results.jsonl");
  if (!fs.existsSync(f)) return [];
  const groups = new Map();
  for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    const key = `${r.promptVersion} | ${r.fixtureConfig}`;
    const g = groups.get(key) ?? { promptVersion: r.promptVersion, fixtureConfig: r.fixtureConfig, benchRuns: 0, runs: 0, passed: 0, firstTry: 0, costUsd: 0, last: r.ts };
    g.benchRuns++; g.runs += r.runs; g.passed += r.passed; g.firstTry += r.firstTry; g.costUsd += r.costUsd; g.last = r.ts;
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function formatComparison(rows) {
  if (!rows.length) return "no benchmark results yet";
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  return rows
    .map((g) => `${g.promptVersion}  [${g.fixtureConfig}]  ${g.benchRuns} bench run(s), ${g.runs} task run(s): pass ${pct(g.passed, g.runs)}, first-try ${pct(g.firstTry, g.runs)}, avg $${(g.costUsd / g.runs).toFixed(3)}/task`)
    .join("\n");
}
