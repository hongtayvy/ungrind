import { spawn } from "node:child_process";

/**
 * Agent runner interface:
 *   run({ prompt, cwd, tier, model, timeoutMs, readOnly? })
 *     -> { output, exitCode, usage: { costUsd, inputTokens, outputTokens }, durationMs, timedOut }
 * Claude Code adapter: headless `claude -p` under the user's existing login.
 * The prompt goes over stdin so it never hits argv limits or shell quoting.
 */
export class ClaudeCodeRunner {
  constructor(agentConfig, { bin = "claude" } = {}) {
    this.cfg = agentConfig;
    this.bin = bin;
  }

  buildArgs({ model, readOnly }) {
    const args = ["-p", "--output-format", "json", "--model", model, "--no-session-persistence"];
    if (readOnly) {
      args.push("--permission-mode", "plan", "--allowedTools", "Read", "Glob", "Grep");
    } else {
      args.push("--permission-mode", "acceptEdits", "--allowedTools", ...this.cfg.allowedTools);
      if (this.cfg.disallowedTools.length) args.push("--disallowedTools", ...this.cfg.disallowedTools);
    }
    return args;
  }

  run({ prompt, cwd, model, timeoutMs, readOnly = false }) {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(this.bin, this.buildArgs({ model, readOnly }), { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ output: `Could not start "${this.bin}": ${e.message}`, exitCode: 127, usage: zero(), durationMs: Date.now() - started, timedOut: false });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ...parseResult(stdout, stderr, code), exitCode: timedOut ? 124 : code ?? 1, durationMs: Date.now() - started, timedOut });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }
}

const zero = () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0 });

/** `claude -p --output-format json` prints one JSON object; fall back to raw text if it does not. */
export function parseResult(stdout, stderr, code) {
  try {
    const j = JSON.parse(stdout);
    const u = j.usage ?? {};
    return {
      output: String(j.result ?? ""),
      usage: {
        costUsd: Number(j.total_cost_usd ?? j.cost_usd ?? 0),
        inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
      },
      isError: Boolean(j.is_error),
    };
  } catch {
    return { output: (stdout + (stderr ? `\n${stderr}` : "")).trim(), usage: zero(), isError: code !== 0 };
  }
}

export function createRunner(agentConfig, deps = {}) {
  if (agentConfig.adapter === "claude-code") return new ClaudeCodeRunner(agentConfig, deps);
  throw new Error(`Unknown agent adapter: ${agentConfig.adapter} (v1 ships claude-code only)`);
}
