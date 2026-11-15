import { spawn } from "node:child_process";

/** Run a CLI agent with the prompt on stdin. Resolves { stdout, stderr, code, timedOut, durationMs, spawnError }. */
/** The environment a child process gets: ours, minus the named secrets Ungrind itself uses (Notion, ntfy), plus extras. */
export function childEnv(unsetEnv = [], extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of unsetEnv) delete env[name];
  return env;
}

export function spawnAgent(bin, args, { cwd, input, timeoutMs, env, unsetEnv = [] }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: childEnv(unsetEnv, env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: 127, timedOut: false, durationMs: Date.now() - started, spawnError: `Could not start "${bin}": ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: timedOut ? 124 : code ?? 1, timedOut, durationMs: Date.now() - started, spawnError: null });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export const zeroUsage = () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
