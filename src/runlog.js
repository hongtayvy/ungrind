import fs from "node:fs";
import path from "node:path";

/** Append one JSON record per run to <stateDir>/runs.jsonl. */
export function writeRunLog(stateDir, record) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
}

export function readRunLog(stateDir) {
  const f = path.join(stateDir, "runs.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** First-try pass rate per prompt version (the number that tells you whether a prompt change helped). */
export function passRateByPromptVersion(records) {
  const out = {};
  for (const r of records) {
    if (r.dryRun || !r.promptVersion || r.result === "nothing-ready") continue;
    const o = (out[r.promptVersion] ??= { runs: 0, firstTryPass: 0, passed: 0 });
    o.runs++;
    if (r.result === "done") o.passed++;
    if (r.result === "done" && r.attempts.length === 1) o.firstTryPass++;
  }
  return out;
}
