import fs from "node:fs";
import path from "node:path";
import { fill, readConventions } from "./prompts.js";
import { renderTaskCard } from "./task.js";

const checksList = (config) => config.verifiers.map((v) => `- ${v.name}: \`${v.command}\``).join("\n");
const strongest = (config) => config.routing.ladder[config.routing.ladder.length - 1];

export const draftPath = (config) => path.join(config.prompts.stateDir, "conventions.draft.md");

/** One-time onboarding: the strongest tier reads the repo (read-only) and drafts the conventions file. */
export async function onboard({ config, runner, templates, log = console.log }) {
  const tier = strongest(config);
  log(`[ungrind] onboarding ${config.project} with ${tier} (read-only)...`);
  const prompt = fill(templates.onboard, { checks: checksList(config) });
  const res = await runner.run({ prompt, cwd: config.repo, tier, model: config.routing.models[tier], timeoutMs: config.agent.timeoutSec * 1000, readOnly: true });
  if (res.exitCode !== 0 || !res.output.trim()) throw new Error(`Onboarding run failed (exit ${res.exitCode}):\n${res.output.slice(-2000)}`);
  fs.mkdirSync(config.prompts.stateDir, { recursive: true });
  fs.writeFileSync(draftPath(config), `${res.output.trim()}\n`);
  log(`[ungrind] draft written to ${draftPath(config)} ($${res.usage.costUsd.toFixed(2)})`);
  log("[ungrind] review and edit it, then run `ungrind approve` to start using it.");
  return draftPath(config);
}

/** Human approval step: the draft only takes effect once a person promotes it. */
export function approve({ config, log = console.log }) {
  const draft = draftPath(config);
  if (!fs.existsSync(draft)) throw new Error(`No draft to approve at ${draft}. Run \`ungrind onboard\` first.`);
  if (fs.existsSync(config.prompts.conventions)) {
    fs.copyFileSync(config.prompts.conventions, `${config.prompts.conventions}.${Date.now()}.bak`);
  }
  fs.renameSync(draft, config.prompts.conventions);
  fs.appendFileSync(path.join(config.prompts.stateDir, "approvals.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), file: "conventions.md" })}\n`);
  log(`[ungrind] approved: ${config.prompts.conventions}`);
}

/** Planner: turn a fuzzy card into crisp ones. Prints proposals; never edits tasks itself. */
export async function plan({ config, runner, templates, task, log = console.log }) {
  const tier = strongest(config);
  const prompt = fill(templates.planner, {
    task: renderTaskCard({ ...task, goal: task.goal || "(none)", criteria: task.criteria.length ? task.criteria : ["(none)"] }),
    files: task.files.map((f) => `- ${f}`).join("\n") || "(none)",
    conventions: readConventions(config.prompts) || "(none)",
    checks: checksList(config),
    notes: task.notes || "(none)",
  });
  const res = await runner.run({ prompt, cwd: config.repo, tier, model: config.routing.models[tier], timeoutMs: config.agent.timeoutSec * 1000, readOnly: true });
  if (res.exitCode !== 0) throw new Error(`Planner run failed (exit ${res.exitCode}):\n${res.output.slice(-2000)}`);
  log(res.output.trim());
  return res.output;
}
