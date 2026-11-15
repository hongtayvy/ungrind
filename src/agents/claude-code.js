import { spawnAgent, zeroUsage } from "./spawn.js";

/**
 * Agent runner interface (every adapter):
 *   run({ prompt, cwd, tier, model, timeoutMs, readOnly?, checks? })
 *     -> { output, exitCode, usage: { costUsd, inputTokens, outputTokens }, durationMs, timedOut }
 * Claude Code adapter: headless `claude -p` under the user's existing login.
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

  async run({ prompt, cwd, model, timeoutMs, readOnly = false }) {
    const r = await spawnAgent(this.bin, this.buildArgs({ model, readOnly }), { cwd, input: prompt, timeoutMs, unsetEnv: this.cfg.unsetEnv });
    if (r.spawnError) return { output: r.spawnError, exitCode: 127, usage: zeroUsage(), durationMs: r.durationMs, timedOut: false };
    return { ...parseResult(r.stdout, r.stderr, r.code), exitCode: r.code, durationMs: r.durationMs, timedOut: r.timedOut };
  }
}

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
    return { output: (stdout + (stderr ? `\n${stderr}` : "")).trim(), usage: zeroUsage(), isError: code !== 0 };
  }
}
