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
  if (typeof guardrails.branchPattern !== "string" || !guardrails.branchPattern.includes("{slug}")) err(`guardrails.branchPattern: must contain {slug}`);
  else if (!/^[A-Za-z0-9][A-Za-z0-9._\/{}-]*$/.test(guardrails.branchPattern) || /\.\.|\/\/|\.lock\b|\/$|@\{/.test(guardrails.branchPattern)) {
    err("guardrails.branchPattern: use letters, numbers, . _ - and / only, starting with a letter or number (for example loop/{slug})");
  }
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
    byTier: isObj(a.byTier) ? a.byTier : {},
    byType: isObj(a.byType) ? a.byType : {},
    codex: isObj(a.codex) ? a.codex : {},
    ollama: isObj(a.ollama) ? a.ollama : {},
    // Ungrind's own credentials (Notion, ntfy) are never passed to agents or check commands.
    unsetEnv: [taskSource.tokenEnv, gates.notify.tokenEnv].filter((n) => typeof n === "string" && n),
    timeoutSec: a.timeoutSec ?? 1200,
    allowedTools: a.allowedTools ?? ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    disallowedTools: a.disallowedTools ?? ["Bash(git push:*)", "Bash(git merge:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git reset:*)", "Bash(git branch:*)"],
  };
  const ADAPTERS = ["claude-code", "codex", "ollama"];
  const used = [agent.adapter, ...Object.values(agent.byTier), ...Object.values(agent.byType)];
  for (const ad of new Set(used)) if (!ADAPTERS.includes(ad)) err(`agent: unknown adapter "${ad}" (use ${ADAPTERS.join(", ")})`);
  for (const t of Object.keys(agent.byTier)) if (strList(routing.ladder) && !routing.ladder.includes(t)) err(`agent.byTier.${t}: "${t}" is not on the ladder`);
  if (strList(routing.ladder)) {
    for (const t of routing.ladder) {
      // byType may move a tier to another adapter, so every adapter that can serve this tier needs a model for it.
      const adapters = new Set(agent.byTier[t] ? [agent.byTier[t]] : [agent.adapter, ...Object.values(agent.byType)]);
      for (const ad of adapters) {
        if (ad === "claude-code" && !routing.models[t]) err(`routing.ladder: tier "${t}" runs on claude-code but has no model in routing.models`);
        if (ad === "ollama" && !agent.ollama.models?.[t]) err(`routing.ladder: tier "${t}" runs on ollama but has no model in agent.ollama.models`);
      }
    }
  }

  const rv = isObj(raw.review) ? raw.review : null;
  const review = rv
    ? { enabled: rv.enabled ?? true, agent: rv.agent ?? "codex", model: rv.model ?? null, blocking: rv.blocking ?? true, maxDiffChars: rv.maxDiffChars ?? 60_000 }
    : { enabled: false };
  if (review.enabled && !ADAPTERS.includes(review.agent)) err(`review.agent: unknown adapter "${review.agent}" (use ${ADAPTERS.join(", ")})`);
  if (review.enabled && review.agent === "ollama" && !review.model) err("review.model: required when review.agent is ollama");

  const p = isObj(raw.prompts) ? raw.prompts : {};
  const stateDir = path.join(repo, p.stateDir ?? ".ungrind");
  const prompts = {
    dir: p.dir ?? null, // null = the templates shipped with Ungrind
    version: p.version ?? "v1",
    stateDir,
    conventions: path.join(stateDir, "conventions.md"),
    requireConventions: p.requireConventions ?? true,
  };

  const c = isObj(raw.cron) ? raw.cron : {};
  const cron = {
    maxTasksPerRun: c.maxTasksPerRun ?? 1,
    dailyUsd: c.dailyUsd ?? null,
    weeklyUsd: c.weeklyUsd ?? null,
    maxRunsPerDay: c.maxRunsPerDay ?? null,
    precheckCommand: c.precheckCommand ?? null,
    lockStaleMin: c.lockStaleMin ?? 180,
  };
  if (!Number.isInteger(cron.maxTasksPerRun) || cron.maxTasksPerRun < 1) err("cron.maxTasksPerRun: must be a positive integer");
  for (const k of ["dailyUsd", "weeklyUsd", "maxRunsPerDay"]) {
    if (cron[k] != null && !(typeof cron[k] === "number" && cron[k] >= 0)) err(`cron.${k}: must be a non-negative number`);
  }

  if (errors.length) return { config: null, errors };
  return { config: { project: raw.project, repo, taskSource, verifiers, guardrails, routing, gates, agent, review, prompts, cron }, errors: [] };
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
