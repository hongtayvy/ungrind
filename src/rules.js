import fs from "node:fs";
import path from "node:path";
import { parseYaml, stringifyYaml } from "./yaml.js";
import { validateConfig, loadConfig } from "./config.js";
import { OllamaRunner } from "./agents/ollama.js";
import { ensureStateIgnore } from "./runlog.js";

/**
 * Rules editing for front ends. The config file stays the source of truth:
 *   getRules  -> the editable rules as JSON, plus Ungrind's defaults and installed local models
 *   saveRules -> merge edits into the file, validate first, keep a backup, never write an invalid file
 * Keys the editor does not know about (task source, notifications, cron, per-type agents, ...) are kept.
 * Comments inside the file are not preserved, apart from the comment block at the very top.
 */

function editable(config) {
  const r = config.routing, g = config.guardrails;
  return {
    verifiers: config.verifiers.map((v) => ({ name: v.name, command: v.command, timeoutSec: v.timeoutSec })),
    forbiddenPaths: g.forbiddenPaths, branchPattern: g.branchPattern, maxAttempts: g.maxAttempts, maxChangedFiles: g.maxChangedFiles, push: g.push,
    ladder: r.ladder, tierBySize: { small: r.tierBySize.small, medium: r.tierBySize.medium, large: r.tierBySize.large },
    defaultTier: r.defaultTier, failuresPerTier: r.failuresPerTier, maxCostUsd: r.maxCostUsd,
    agentDefault: config.agent.adapter, localModel: config.agent.ollama?.models?.local ?? null,
    humanApprovalTypes: config.gates.humanApprovalTypes,
    review: { enabled: config.review.enabled, agent: config.review.agent ?? "codex", blocking: config.review.blocking ?? true },
  };
}

function readRaw(file) {
  const text = fs.readFileSync(file, "utf8");
  return { text, raw: file.endsWith(".json") ? JSON.parse(text) : parseYaml(text) };
}

export async function getRules(config, { fetch } = {}) {
  const { raw } = readRaw(config.file);
  // Ungrind's base rules: what this project would get with only its identity, task source, and checks.
  const base = validateConfig({ project: raw.project, repo: raw.repo, taskSource: raw.taskSource, verifiers: raw.verifiers }, { baseDir: path.dirname(config.file) });
  let installedLocalModels = [];
  try { installedLocalModels = await new OllamaRunner(config.agent.ollama, fetch ? { fetch } : {}).installedModels(); } catch { /* Ollama not running: no local models to offer */ }
  return { rules: editable(config), defaults: base.config ? editable(base.config) : null, installedLocalModels, knownTiers: ["local", "haiku", "sonnet", "opus"], agents: ["claude-code", "codex"] };
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function saveRules(configFile, rules) {
  const file = path.resolve(configFile);
  const { text, raw } = readRaw(file);
  const next = { ...raw };

  const oldByName = Object.fromEntries((Array.isArray(raw.verifiers) ? raw.verifiers : []).map((v) => [v?.name, v]));
  next.verifiers = (rules.verifiers ?? []).map((v) => clean({ ...(oldByName[v.name] ?? {}), name: String(v.name ?? "").trim(), command: String(v.command ?? "").trim(), timeoutSec: Number(v.timeoutSec) || 300 }));

  next.guardrails = clean({ ...(raw.guardrails ?? {}), forbiddenPaths: rules.forbiddenPaths, branchPattern: rules.branchPattern, maxAttempts: rules.maxAttempts, maxChangedFiles: rules.maxChangedFiles, push: rules.push });
  next.routing = clean({ ...(raw.routing ?? {}), tierBySize: { ...(raw.routing?.tierBySize ?? {}), ...rules.tierBySize }, defaultTier: rules.defaultTier, ladder: rules.ladder, failuresPerTier: rules.failuresPerTier, maxCostUsd: rules.maxCostUsd });

  const agent = { ...(raw.agent ?? {}) };
  if (rules.agentDefault) agent.adapter = rules.agentDefault;
  const byTier = { ...(agent.byTier ?? {}) };
  if ((rules.ladder ?? []).includes("local")) {
    byTier.local = "ollama";
    agent.ollama = { ...(agent.ollama ?? {}), models: { ...(agent.ollama?.models ?? {}), ...(rules.localModel ? { local: rules.localModel } : {}) } };
  } else delete byTier.local;
  for (const t of Object.keys(byTier)) if (!(rules.ladder ?? []).includes(t)) delete byTier[t];
  if (Object.keys(byTier).length) agent.byTier = byTier; else delete agent.byTier;
  if (Object.keys(agent).length) next.agent = agent; else delete next.agent;

  next.gates = clean({ ...(raw.gates ?? {}), humanApprovalTypes: rules.humanApprovalTypes });
  if (rules.review?.enabled) next.review = clean({ ...(raw.review ?? {}), enabled: undefined, agent: rules.review.agent, blocking: rules.review.blocking });
  else delete next.review;

  const { errors } = validateConfig(next, { baseDir: path.dirname(file) });
  if (errors.length) throw new Error(`These rules aren't valid, so nothing was saved:\n- ${errors.join("\n- ")}`);

  let out;
  if (file.endsWith(".json")) out = `${JSON.stringify(next, null, 2)}\n`;
  else {
    const header = text.match(/^(?:#.*\r?\n)+/)?.[0] ?? "";
    out = `${header}${stringifyYaml(next)}\n`;
    parseYaml(out); // never write something we can't read back
  }
  const stateDir = loadConfig(file).prompts.stateDir;
  ensureStateIgnore(stateDir);
  const backup = path.join(stateDir, `rules.backup${path.extname(file)}`);
  fs.writeFileSync(backup, text);
  fs.writeFileSync(file, out);
  return { saved: true, backup };
}
