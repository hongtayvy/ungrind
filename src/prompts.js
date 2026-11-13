import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { renderTaskCard } from "./task.js";

const SHIPPED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const FILES = ["local", "haiku", "sonnet", "opus", "planner", "retry", "onboard", "review", "propose"];

export function loadTemplates(promptsCfg) {
  const dir = path.join(promptsCfg.dir ? path.resolve(promptsCfg.dir) : SHIPPED, promptsCfg.version);
  const t = {};
  const hash = crypto.createHash("sha256");
  for (const name of FILES) {
    const f = path.join(dir, `${name}.md`);
    if (!fs.existsSync(f)) throw new Error(`Missing prompt template: ${f}`);
    t[name] = fs.readFileSync(f, "utf8");
    hash.update(name).update(t[name]);
  }
  // Version id changes whenever any template changes, so run logs compare like with like.
  t.version = `${promptsCfg.version}+${hash.digest("hex").slice(0, 8)}`;
  return t;
}

export function fill(template, slots) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in slots)) throw new Error(`Unfilled prompt slot: {{${k}}}`);
    return slots[k];
  });
}

export function readConventions(promptsCfg) {
  return fs.existsSync(promptsCfg.conventions) ? fs.readFileSync(promptsCfg.conventions, "utf8").trim() : "";
}

/** Build the prompt for one attempt. Retries append the retry template with the exact verifier output. */
export function buildPrompt({ templates, tier, task, config, conventions, notes, failure }) {
  const slots = {
    task: renderTaskCard(task),
    files: task.files.map((f) => `- ${f}`).join("\n"),
    conventions: conventions || "(no project conventions file yet)",
    checks: config.verifiers.map((v) => `- ${v.name}: \`${v.command}\``).join("\n"),
    notes: notes || "(none: this is the first attempt)",
    failure: failure || "",
  };
  let prompt = fill(templates[tier] ?? templates.sonnet, slots);
  if (failure) prompt += `\n\n${fill(templates.retry, slots)}`;
  return prompt;
}

/** Pull the change summary and any self-reported block out of the agent's final message. */
export function parseAgentOutput(output) {
  const blocked = output.match(/^UNGRIND_BLOCKED:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const idx = output.lastIndexOf("UNGRIND_SUMMARY:");
  const summary = idx >= 0 ? output.slice(idx + "UNGRIND_SUMMARY:".length).trim() : output.trim().slice(-1500);
  return { blocked, summary };
}
