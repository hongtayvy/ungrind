import { spawn } from "node:child_process";
import path from "node:path";
import { changedFiles } from "../git.js";
import { matchesAny } from "../glob.js";

const MAX_OUTPUT = 6000;
const tail = (s) => (s.length > MAX_OUTPUT ? `[...truncated...]\n${s.slice(-MAX_OUTPUT)}` : s);

/**
 * Check 1: command check. Runs a shell command; passes on the configured exit code (default 0),
 * fails on timeout. Captures stdout+stderr for the retry prompt.
 * Result shape for every check: { name, passed, output, durationMs }
 */
export function commandCheck(check, repo) {
  const started = Date.now();
  const cwd = path.resolve(repo, check.cwd);
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", check.command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, check.timeoutSec * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const done = (passed, extra) => {
      clearTimeout(timer);
      resolve({ name: check.name, passed, output: tail(`$ ${check.command}\n${out}${extra}`), durationMs: Date.now() - started });
    };
    child.on("error", (e) => done(false, `\n[could not run: ${e.message}]`));
    child.on("close", (code) => {
      if (timedOut) done(false, `\n[timed out after ${check.timeoutSec}s]`);
      else if (code === check.pass.exitCode) done(true, "");
      else done(false, `\n[exit code ${code}, expected ${check.pass.exitCode}]`);
    });
  });
}

/**
 * Check 2: diff guard. Fails if any changed file matches a forbidden path, falls outside the
 * task's files-in-scope, or if the diff touches more files than guardrails.maxChangedFiles.
 */
export function diffGuard({ repo, task, guardrails, excludes }) {
  const started = Date.now();
  const files = changedFiles(repo, excludes);
  const problems = [];
  const forbidden = files.filter((f) => matchesAny(f, guardrails.forbiddenPaths));
  if (forbidden.length) problems.push(`Forbidden paths changed: ${forbidden.join(", ")}`);
  const outside = files.filter((f) => !forbidden.includes(f) && !matchesAny(f, task.files));
  if (outside.length) problems.push(`Files outside the task's scope (${task.files.join(", ")}): ${outside.join(", ")}`);
  if (files.length > guardrails.maxChangedFiles) problems.push(`Diff touches ${files.length} files; limit is ${guardrails.maxChangedFiles}`);
  return {
    name: "diff-guard",
    passed: problems.length === 0,
    output: problems.length ? problems.join("\n") : `ok (${files.length} file(s) changed)`,
    durationMs: Date.now() - started,
    files,
  };
}

/** Run diff guard first (cheap, fails fast), then the configured checks in order; stop at first failure. */
export async function runVerifiers({ config, task, excludes }) {
  const results = [];
  const guard = diffGuard({ repo: config.repo, task, guardrails: config.guardrails, excludes });
  results.push(guard);
  if (!guard.passed) return { passed: false, results, files: guard.files };
  for (const check of config.verifiers) {
    const r = await commandCheck(check, config.repo);
    results.push(r);
    if (!r.passed) return { passed: false, results, files: guard.files };
  }
  return { passed: true, results, files: guard.files };
}
