import { spawnAgent, zeroUsage } from "./spawn.js";

/**
 * Codex adapter: `codex exec` non-interactive mode (flags per OpenAI's non-interactive docs):
 *   codex exec --json --ephemeral --skip-git-repo-check -C <cwd> -s <sandbox> [-m <model>] -
 * The trailing `-` reads the prompt from stdin. `--json` prints JSON Lines events:
 * the final text is the last `item.completed` with item.type "agent_message",
 * token usage arrives on `turn.completed`.
 * Codex reports tokens, not dollars: set agent.codex.pricing { inputPerMTok, outputPerMTok }
 * to get a cost estimate (otherwise cost is logged as 0 and the cost ceiling cannot see it).
 */
export class CodexRunner {
  constructor(codexConfig = {}, { bin = "codex" } = {}) {
    this.cfg = codexConfig;
    this.bin = bin;
  }

  buildArgs({ cwd, model, readOnly }) {
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", cwd, "-s", readOnly ? "read-only" : "workspace-write"];
    if (model) args.push("-m", model);
    args.push("-");
    return args;
  }

  async run({ prompt, cwd, model, timeoutMs, readOnly = false }) {
    const r = await spawnAgent(this.bin, this.buildArgs({ cwd, model, readOnly }), { cwd, input: prompt, timeoutMs });
    if (r.spawnError) return { output: r.spawnError, exitCode: 127, usage: zeroUsage(), durationMs: r.durationMs, timedOut: false };
    const parsed = parseCodexJsonl(r.stdout, this.cfg.pricing);
    const exitCode = r.code !== 0 ? r.code : parsed.failed ? 1 : 0;
    const output = parsed.output || `${parsed.errors.join("\n")}\n${r.stderr}`.trim();
    return { output, exitCode, usage: parsed.usage, durationMs: r.durationMs, timedOut: r.timedOut };
  }
}

export function parseCodexJsonl(stdout, pricing = null) {
  const usage = zeroUsage();
  const messages = [], errors = [];
  let failed = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") messages.push(String(ev.item.text ?? ""));
    if (ev.type === "turn.completed" && ev.usage) {
      usage.inputTokens += Number(ev.usage.input_tokens ?? 0);
      usage.outputTokens += Number(ev.usage.output_tokens ?? 0) + Number(ev.usage.reasoning_output_tokens ?? 0);
    }
    if (ev.type === "turn.failed" || ev.type === "error") {
      failed = true;
      errors.push(ev.error?.message ?? ev.message ?? JSON.stringify(ev));
    }
  }
  if (pricing) usage.costUsd = (usage.inputTokens * (pricing.inputPerMTok ?? 0) + usage.outputTokens * (pricing.outputPerMTok ?? 0)) / 1e6;
  return { output: messages.at(-1) ?? "", usage, failed, errors };
}
