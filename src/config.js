import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "./yaml.js";

export const TIERS = ["haiku", "sonnet", "opus"];
export const STATUSES = ["ready", "in_progress", "done", "blocked"];

export const DEFAULT_MODELS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

const DEFAULT_STATUS_NAMES = {
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validate a raw config object. Returns { config, errors }. config has defaults applied. */
export function validateConfig(raw, { baseDir = process.cwd() } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(raw)) return { config: null, errors: ["config must be a mapping"] };

  // 1. Identity and task source
  if (typeof raw.project !== "string" || !raw.project.trim()) err("project: required string");
  const repo = path.resolve(baseDir, typeof raw.repo === "string" ? raw.repo : ".");
  if (!fs.existsSync(repo)) err(`repo: path does not exist: ${repo}`);

  const ts = raw.taskSource;
  const taskSource = { adapter: "local", statuses: { ...DEFAULT_STATUS_NAMES } };
  if (!isObj(ts)) err("taskSource: required mapping");
  else {
    if (!["local", "notion"].includes(ts.adapter)) err(`taskSource.adapter: must be "local" or "notion"`);
    Object.assign(taskSource, ts);
    taskSource.statuses = { ...DEFAULT_STATUS_NAMES, ...(isObj(ts.statuses) ? ts.statuses : {}) };
    for (const k of Object.keys(taskSource.statuses)) {
      if (!STATUSES.includes(k)) err(`taskSource.statuses.${k}: unknown status (use ${STATUSES.join(", ")})`);
    }
    if (ts.adapter === "local") taskSource.path = ts.path ?? "tasks";
    if (ts.adapter === "notion") {
      if (typeof ts.databaseId !== "string") err("taskSource.databaseId: required for notion");
      taskSource.tokenEnv = ts.tokenEnv ?? "NOTION_TOKEN";
    }
  }

  // 2. Verifier contract
  const verifiers = [];
  if (raw.verifiers !== undefined && !Array.isArray(raw.verifiers)) err("verifiers: must be a list");
  (Array.isArray(raw.verifiers) ? raw.verifiers : []).forEach((v, i) => {
    const where = `verifiers[${i}]`;
    if (!isObj(v)) return err(`${where}: must be a mapping`);
    if (typeof v.name !== "string") err(`${where}.name: required string`);
    if (typeof v.command !== "string") err(`${where}.command: required string`);
    if (v.timeoutSec !== undefined && !(typeof v.timeoutSec === "number" && v.timeoutSec > 0)) err(`${where}.timeoutSec: must be a positive number`);
    const pass = isObj(v.pass) ? v.pass : {};
    verifiers.push({
      type: "command",
      name: v.name,
      command: v.command,
      cwd: v.cwd ?? ".",
      timeoutSec: v.timeoutSec ?? 300,
      pass: { exitCode: pass.exitCode ?? 0 },
    });
  });
  if (verifiers.length === 0) err("verifiers: at least one check is required (a loop with no verifier converges on wrong answers)");

  // 3. Guardrails
  const g = isObj(raw.guardrails) ? raw.guardrails : {};
  if (g.forbiddenPaths !== undefined && !strList(g.forbiddenPaths)) err("guardrails.forbiddenPaths: must be a list of strings");
  const guardrails = {
    forbiddenPaths: g.forbiddenPaths ?? [".env", ".env.*", "**/secrets/**", "**/*.pem", "**/*.key"],
    branchPattern: g.branchPattern ?? "loop/{slug}",
    maxAttempts: g.maxAttempts ?? 6,
    maxChangedFiles: g.maxChangedFiles ?? 15,
    push: g.push ?? true,
    remote: g.remote ?? "origin",
    protectedBranches: g.protectedBranches ?? ["main", "master"],
  };
  if (!guardrails.branchPattern.includes("{slug}")) err(`guardrails.branchPattern: must contain {slug}`);
  if (!Number.isInteger(guardrails.maxAttempts) || guardrails.maxAttempts < 1) err("guardrails.maxAttempts: must be a positive integer");

  // 4. Routing
  const r = isObj(raw.routing) ? raw.routing : {};
  const routing = {
    tierBySize: { small: "haiku", medium: "sonnet", large: "opus", ...(isObj(r.tierBySize) ? r.tierBySize : {}) },
    defaultTier: r.defaultTier ?? "sonnet",
    ladder: r.ladder ?? [...TIERS],
    failuresPerTier: r.failuresPerTier ?? 2,
    maxCostUsd: r.maxCostUsd ?? 5,
    models: { ...DEFAULT_MODELS, ...(isObj(r.models) ? r.models : {}) },
  };
  if (!strList(routing.ladder) || routing.ladder.length === 0) err("routing.ladder: must be a non-empty list of tiers");
  else for (const t of routing.ladder) if (!routing.models[t]) err(`routing.ladder: tier "${t}" has no model in routing.models`);
  for (const [size, t] of Object.entries(routing.tierBySize)) {
    if (!routing.ladder.includes(t)) err(`routing.tierBySize.${size}: "${t}" is not on the ladder`);
  }
  if (!routing.ladder.includes(routing.defaultTier)) err(`routing.defaultTier: "${routing.defaultTier}" is not on the ladder`);

  // 5. Human gates and notifications (notifications are parsed now, sent in v2)
  const h = isObj(raw.gates) ? raw.gates : {};
  const gates = {
    humanApprovalTypes: h.humanApprovalTypes ?? ["auth", "payments", "migration"],
    notify: {
      ntfyTopic: h.notify?.ntfyTopic ?? null,
      server: h.notify?.server ?? "https://ntfy.sh",
      tokenEnv: h.notify?.tokenEnv ?? null,
      on: h.notify?.on ?? ["done", "blocked", "skipped", "ceiling"],
    },
  };
  if (!strList(gates.humanApprovalTypes)) err("gates.humanApprovalTypes: must be a list of strings");
  const EVENTS = ["done", "blocked", "skipped", "ceiling"];
  if (!strList(gates.notify.on) || gates.notify.on.some((e) => !EVENTS.includes(e))) err(`gates.notify.on: must be a list of ${EVENTS.join(", ")}`);

  // Agent + prompts (engine plumbing, all optional)
  const a = isObj(raw.agent) ? raw.agent : {};
  const agent = {
    adapter: a.adapter ?? "claude-code",
    timeoutSec: a.timeoutSec ?? 1200,
    allowedTools: a.allowedTools ?? ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    disallowedTools: a.disallowedTools ?? ["Bash(git push:*)", "Bash(git merge:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git reset:*)", "Bash(git branch:*)"],
  };
  const p = isObj(raw.prompts) ? raw.prompts : {};
  const stateDir = path.join(repo, p.stateDir ?? ".ungrind");
  const prompts = {
    dir: p.dir ?? null, // null = the templates shipped with Ungrind
    version: p.version ?? "v1",
    stateDir,
    conventions: path.join(stateDir, "conventions.md"),
    requireConventions: p.requireConventions ?? true,
  };

  if (errors.length) return { config: null, errors };
  return { config: { project: raw.project, repo, taskSource, verifiers, guardrails, routing, gates, agent, prompts }, errors: [] };
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`Config not found: ${abs}`);
  const text = fs.readFileSync(abs, "utf8");
  let raw;
  try {
    raw = abs.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new Error(`Could not parse ${abs}: ${e.message}`);
  }
  const { config, errors } = validateConfig(raw, { baseDir: path.dirname(abs) });
  if (errors.length) throw new Error(`Invalid config ${abs}:\n  - ${errors.join("\n  - ")}`);
  config.file = abs;
  return config;
}
