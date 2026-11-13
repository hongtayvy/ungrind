import fs from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import { fill } from "./prompts.js";
import { renderTaskCard } from "./task.js";
import { modelFor } from "./agents/index.js";

/**
 * Cross-vendor review: after the checks pass, a different agent reads the diff (read-only)
 * and returns PASS or FAIL. Config:
 *   review:
 *     agent: codex        # claude-code | codex | ollama; ideally a different family than the builder
 *     model: null         # default: that adapter's model for the strongest ladder tier
 *     blocking: true      # FAIL (or no verdict) counts as a failed attempt and feeds the retry prompt
 *     maxDiffChars: 60000
 */

/** Unified diff of the changed files vs HEAD, with untracked files shown as new files. */
export function diffText(repo, files, maxChars = 60_000) {
  const tracked = new Set(git(repo, ["ls-files", "--", ...files]).split("\n").filter(Boolean));
  const parts = [];
  if (tracked.size) parts.push(git(repo, ["-c", "core.quotepath=off", "diff", "--relative", "HEAD", "--", ...tracked]));
  for (const f of files.filter((f) => !tracked.has(f))) {
    const p = path.join(repo, f);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, "utf8").split("\n").map((l) => `+${l}`).join("\n");
    parts.push(`diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${body}`);
  }
  const text = parts.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[...diff truncated at ${maxChars} chars]` : text;
}

export function parseVerdict(output) {
  const m = output.match(/UNGRIND_REVIEW:\s*(PASS|FAIL)\b([\s\S]*)$/i);
  if (!m) return { verdict: null, issues: "" };
  return { verdict: m[1].toUpperCase(), issues: m[2].trim() };
}

/** Returns { verdict: PASS | FAIL | null, issues, output, agent, model, costUsd, durationMs, exitCode }. */
export async function reviewChange({ config, runners, templates, task, files, conventions }) {
  const rc = config.review;
  const tier = config.routing.ladder[config.routing.ladder.length - 1];
  const model = rc.model ?? modelFor(config, rc.agent, tier);
  const prompt = fill(templates.review, {
    task: renderTaskCard(task),
    files: task.files.map((f) => `- ${f}`).join("\n"),
    conventions: conventions || "(none)",
    diff: diffText(config.repo, files, rc.maxDiffChars),
  });
  const res = await runners.get(rc.agent).run({ prompt, cwd: config.repo, tier, model, timeoutMs: config.agent.timeoutSec * 1000, readOnly: true });
  const v = res.exitCode === 0 ? parseVerdict(res.output) : { verdict: null, issues: "" };
  return { ...v, output: res.output.slice(-4000), agent: rc.agent, model, costUsd: res.usage.costUsd ?? 0, durationMs: res.durationMs, exitCode: res.exitCode };
}
