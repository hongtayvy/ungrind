import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "./yaml.js";
import { validateTask, readyCandidates, slugify } from "./task.js";
import { readRunLog } from "./runlog.js";
import { agentFor, modelFor, startTier, routeProblems, ADAPTERS } from "./agents/index.js";
import { loadTemplates } from "./prompts.js";

/**
 * JSON surface for front ends (the Mac app). The engine stays the source of truth:
 *   ungrind state      -> project rules, feature cards with their route and problems, recent runs
 *   ungrind card-save  -> create or update a card file from JSON on stdin (local files adapter)
 *   ungrind init       -> write a starter config and tasks folder into a directory
 */

export async function buildProjectState(config, source, { maxRuns = 200 } = {}) {
  const tasks = await source.listTasks();
  const runnable = new Set(readyCandidates(tasks).map((t) => t.id));
  let promptVersion = null;
  try { promptVersion = loadTemplates(config.prompts).version; } catch { /* reported by validate */ }
  const cards = tasks.map((t) => {
    const tier = startTier(config, t);
    const agent = agentFor(config, t, tier);
    return {
      id: t.id, title: t.title ?? "", goal: t.goal ?? "", criteria: t.criteria ?? [], files: t.files ?? [],
      status: t.status, priority: Number.isFinite(t.priority) ? t.priority : null, dependencies: t.dependencies ?? [],
      size: t.size ?? null, type: t.type ?? null, tier: t.tier ?? null, agent: t.agent ?? null,
      approved: Boolean(t.approved), archived: Boolean(t.archived),
      problems: [...validateTask(t), ...routeProblems(config, t)],
      waiting: t.status === "ready" && !t.archived && !runnable.has(t.id),
      needsApproval: Boolean(t.type && config.gates.humanApprovalTypes.includes(t.type) && !t.approved),
      notes: t.notes ?? "", summary: t.summary ?? "", file: t._file ?? null,
      route: { startTier: tier, agent, model: modelFor(config, agent, tier), overridden: Boolean(t.tier || t.agent) },
    };
  });
  const runs = readRunLog(config.prompts.stateDir).filter((r) => r.task).slice(-maxRuns).reverse().map((r) => ({
    ts: r.ts, taskId: r.task.id, task: r.task.title, result: r.result, reason: r.reason ?? null, branch: r.branch ?? null,
    dryRun: Boolean(r.dryRun), pushed: Boolean(r.pushed),
    path: (r.attempts ?? []).map((a) => `${a.tier}${a.passed ? "✓" : "✗"}`).join(" → "),
    agents: [...new Set((r.attempts ?? []).map((a) => a.agent ?? "claude-code"))].join(", "),
    attempts: (r.attempts ?? []).length, costUsd: r.totalCostUsd ?? 0, durationMs: r.durationMs ?? 0,
  }));
  const r = config.routing, g = config.guardrails;
  return {
    project: config.project, repo: config.repo, configFile: config.file ?? null, adapter: config.taskSource.adapter,
    promptVersion, conventionsApproved: fs.existsSync(config.prompts.conventions),
    rules: {
      ladder: r.ladder, tierBySize: r.tierBySize, defaultTier: r.defaultTier, failuresPerTier: r.failuresPerTier, maxCostUsd: r.maxCostUsd,
      maxAttempts: g.maxAttempts, maxChangedFiles: g.maxChangedFiles, forbiddenPaths: g.forbiddenPaths, branchPattern: g.branchPattern,
      verifiers: config.verifiers.map((v) => ({ name: v.name, command: v.command })),
      agents: { default: config.agent.adapter, byTier: config.agent.byTier, byType: config.agent.byType, available: ADAPTERS },
      humanApprovalTypes: config.gates.humanApprovalTypes,
      review: config.review.enabled ? { agent: config.review.agent, blocking: config.review.blocking } : null,
    },
    cards, runs,
  };
}

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_ ./-]*$/;
function yamlValue(v) {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  if (v && typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string") return PLAIN.test(v) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v) ? v : JSON.stringify(v);
  return String(v);
}

/** Replace (or insert) `## Goal` and `## Acceptance criteria`, keeping every other section (Notes, Summary, ...). */
function rebuildBody(oldBody, goal, criteria) {
  const sections = [];
  let cur = { heading: null, lines: [] };
  for (const line of oldBody.split(/\r?\n/)) {
    if (/^## /.test(line)) { sections.push(cur); cur = { heading: line.slice(3).trim(), lines: [] }; }
    else cur.lines.push(line);
  }
  sections.push(cur);
  const preamble = sections[0].lines.join("\n").trim();
  const rest = sections.slice(1).filter((s) => !["goal", "acceptance criteria", "criteria"].includes(s.heading.toLowerCase()));
  const out = [];
  if (preamble) out.push(preamble, "");
  out.push("## Goal", goal.trim(), "", "## Acceptance criteria", ...criteria.filter((c) => c.trim()).map((c) => `- ${c.trim()}`));
  for (const s of rest) out.push("", `## ${s.heading}`, "", s.lines.join("\n").replace(/^\n+|\s+$/g, ""));
  return `${out.join("\n")}\n`;
}

/**
 * Create or update a card file. `card`: { id?, title, goal, criteria[], files[], status, priority,
 * size?, type?, tier?, agent?, dependencies[], approved, archived }. Unknown front matter keys
 * (e.g. Obsidian properties) and engine-written sections are preserved.
 */
export function saveCard(config, card) {
  if (config.taskSource.adapter !== "local") throw new Error("Editing cards is only supported for the local files task source.");
  if (!card.title || !String(card.title).trim()) throw new Error("A card needs a title.");
  const dir = path.resolve(config.repo, config.taskSource.path);
  fs.mkdirSync(dir, { recursive: true });
  let file;
  if (card.id) {
    file = findCardFile(dir, card.id);
    if (!file) throw new Error(`No card with id ${card.id}`);
  } else {
    const base = slugify(card.title);
    let name = base, n = 2;
    while (fs.existsSync(path.join(dir, `${name}.md`))) name = `${base}-${n++}`;
    file = path.join(dir, `${name}.md`);
  }
  const existing = fs.existsSync(file) ? parseFrontMatter(fs.readFileSync(file, "utf8")) : { data: {}, body: "" };
  const statusName = config.taskSource.statuses[card.status ?? "ready"];
  if (!statusName) throw new Error(`Unknown status "${card.status}"`);
  const data = { ...existing.data };
  delete data.goal; delete data.criteria; // these live in the body
  Object.assign(data, { title: String(card.title).trim(), status: statusName, priority: Number.isFinite(card.priority) ? card.priority : 1, files: card.files ?? [] });
  const optional = { size: card.size, type: card.type, tier: card.tier, agent: card.agent };
  for (const [k, v] of Object.entries(optional)) { if (v) data[k] = v; else delete data[k]; }
  if (card.dependencies?.length) data.dependencies = card.dependencies; else delete data.dependencies;
  for (const k of ["approved", "archived"]) { if (card[k]) data[k] = true; else delete data[k]; }
  const fm = Object.entries(data).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${yamlValue(v)}`).join("\n");
  fs.writeFileSync(file, `---\n${fm}\n---\n${rebuildBody(existing.body, card.goal ?? "", card.criteria ?? [])}`);
  return { id: data.id ? String(data.id) : path.basename(file, ".md"), file };
}

function findCardFile(dir, id) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".md")) {
        if (path.basename(e.name, ".md") === id) return p;
        const { data } = parseFrontMatter(fs.readFileSync(p, "utf8"));
        if (data.id != null && String(data.id) === id) return p;
      }
    }
  }
  return null;
}

const CONFIG_NAMES = ["ungrind.config.yaml", "ungrind.config.yml", "ungrind.config.json"];
export const findConfig = (dir) => CONFIG_NAMES.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p)) ?? null;

/** Guess the project's test command so the starter config has a real verifier where possible. */
export function detectVerifier(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has("package.json")) {
    try { if (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts?.test) return { name: "tests", command: "npm test --silent" }; } catch { /* fall through */ }
  }
  if (has("Cargo.toml")) return { name: "tests", command: "cargo test --quiet" };
  if (has("go.mod")) return { name: "tests", command: "go test ./..." };
  if (has("Package.swift")) return { name: "tests", command: "swift test" };
  if (has("pom.xml")) return { name: "tests", command: "mvn -q test" };
  if (has("gradlew")) return { name: "tests", command: "./gradlew test" };
  if (has("pyproject.toml") || has("pytest.ini")) return { name: "tests", command: "python -m pytest -q" };
  return null;
}

/** Write a starter config and tasks folder. Never overwrites an existing config. */
export function initProject(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`Folder not found: ${abs}`);
  const existing = findConfig(abs);
  if (existing) return { configFile: existing, created: false, verifier: null };
  const v = detectVerifier(abs);
  const name = path.basename(abs).replace(/[^A-Za-z0-9_.-]+/g, "-") || "project";
  const yaml = `# Ungrind rules for this folder. Edit here or in the Ungrind app; both read this file.
project: ${name}
repo: .

taskSource:
  adapter: local
  path: tasks              # one markdown feature card per file

verifiers:                 # run in order after every attempt
  - name: ${v ? v.name : "placeholder"}
    command: ${JSON.stringify(v ? v.command : "true")}${v ? "" : "   # TODO: replace with your real test or build command"}
    timeoutSec: 600

guardrails:
  forbiddenPaths: [".env", ".env.*", "**/secrets/**", "**/*.pem", "**/*.key"]
  branchPattern: "loop/{slug}"
  maxAttempts: 6
  maxChangedFiles: 15

routing:
  tierBySize: { small: haiku, medium: sonnet, large: opus }
  defaultTier: sonnet
  ladder: [haiku, sonnet, opus]
  failuresPerTier: 2
  maxCostUsd: 5

gates:
  humanApprovalTypes: [auth, payments, migration]
`;
  const configFile = path.join(abs, CONFIG_NAMES[0]);
  fs.writeFileSync(configFile, yaml);
  fs.mkdirSync(path.join(abs, "tasks"), { recursive: true });
  return { configFile, created: true, verifier: v };
}
