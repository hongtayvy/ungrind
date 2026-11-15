import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, changedFiles, hasRemote } from "./git.js";
import { engineExcludes } from "./engine.js";
import { agentFor } from "./agents/index.js";
import { draftPath } from "./onboard.js";

/**
 * Setup check: is this Mac, and optionally this project, ready to run cards?
 * Each check: { id, scope: "tools" | "project", title, status: "ok" | "warn" | "fail" | "info", detail, fix? }
 *   fail = runs will not work; warn = works, but you should know; info = optional and not set up.
 * It only reads state. Nothing is installed, signed in, or changed.
 */

function defaultExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, ...opts });
  return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export async function doctor({ config = null, configError = null, exec = defaultExec, fetch = globalThis.fetch, env = process.env, nodeVersion = process.versions.node } = {}) {
  const checks = [];
  const add = (scope, id, title, status, detail, fix = null) => checks.push({ id, scope, title, status, detail, fix });

  // ---- This Mac ----
  const major = Number(String(nodeVersion).split(".")[0]);
  if (major >= 20) add("tools", "node", "Node.js", "ok", `Version ${nodeVersion}`);
  else add("tools", "node", "Node.js", "fail", `Version ${nodeVersion} is too old. Ungrind needs 20 or later.`, "brew install node");

  const g = exec("git", ["--version"]);
  if (g.code === 0) add("tools", "git", "Git", "ok", g.stdout.trim().replace(/^git version /, "Version "));
  else add("tools", "git", "Git", "fail", "Git wasn't found. Ungrind does every run on a git branch.", "xcode-select --install");

  const c = exec("claude", ["--version"]);
  let claudeReady = false;
  if (c.code !== 0) {
    add("tools", "claude", "Claude Code", "fail", "The `claude` command wasn't found. Ungrind runs cards through Claude Code.", "npm install -g @anthropic-ai/claude-code");
  } else {
    add("tools", "claude", "Claude Code", "ok", `Version ${c.stdout.trim().split(/\s+/)[0]}`);
    const a = exec("claude", ["auth", "status", "--json"]);
    let status = null;
    try { status = JSON.parse(a.stdout); } catch { /* older CLI or unexpected output */ }
    if (!status) add("tools", "claude-login", "Claude sign-in", "warn", "Couldn't read the sign-in status. Run `claude` once in Terminal to make sure you're signed in.", "claude auth status");
    else if (!status.loggedIn) add("tools", "claude-login", "Claude sign-in", "fail", "Claude Code isn't signed in.", "claude auth login");
    else {
      claudeReady = true;
      const plan = status.subscriptionType ? ` (${cap(String(status.subscriptionType))})` : "";
      if (env.ANTHROPIC_API_KEY) add("tools", "claude-login", "Claude sign-in", "warn", "Signed in, but ANTHROPIC_API_KEY is set in your shell, so runs are billed to that API key instead of your subscription.", "unset ANTHROPIC_API_KEY");
      else if (status.authMethod === "claude.ai") add("tools", "claude-login", "Claude sign-in", "ok", `Signed in with your Claude subscription${plan}. Runs count against that plan's limits.`);
      else add("tools", "claude-login", "Claude sign-in", "ok", `Signed in (${status.authMethod ?? "unknown method"}). Runs are billed to that account.`);
    }
  }

  let ollamaModels = null;
  try {
    const host = (config?.agent.ollama?.host ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) ollamaModels = ((await res.json()).models ?? []).map((m) => m.name);
  } catch { /* not running */ }
  if (ollamaModels) add("tools", "ollama", "Ollama (local models)", ollamaModels.length ? "ok" : "info", ollamaModels.length ? `Running, ${ollamaModels.length} model${ollamaModels.length === 1 ? "" : "s"} installed. Local runs cost nothing.` : "Running, but no models are installed. Only needed for the local tier.");
  else add("tools", "ollama", "Ollama (local models)", "info", "Not running. Only needed if you turn on the local tier.");

  const x = exec("codex", ["--version"]);
  const codexReady = x.code === 0;
  add("tools", "codex", "Codex", codexReady ? "ok" : "info", codexReady ? `Version ${x.stdout.trim().split(/\s+/).pop()}` : "Not installed. Only needed if you route cards or reviews to Codex.");

  // ---- This project ----
  let conventions = null;
  if (configError) add("project", "rules", "Rules file", "fail", configError);
  if (config) {
    const repo = config.repo;
    add("project", "rules", "Rules file", "ok", path.basename(config.file ?? "ungrind.config.yaml"));

    const inRepo = git(repo, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }) === "true";
    const hasCommit = inRepo && git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true });
    if (!inRepo) add("project", "repo", "Git repository", "fail", "This folder isn't a git repository. Ungrind works on branches, so it needs one.", "git init && git add -A && git commit -m \"Initial commit\"");
    else if (!hasCommit) add("project", "repo", "Git repository", "fail", "The repository has no commits yet, so there is nothing to branch from.", "git add -A && git commit -m \"Initial commit\"");
    else {
      add("project", "repo", "Git repository", "ok", `On branch ${git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })}`);
      const dirty = changedFiles(repo, engineExcludes(config));
      if (dirty.length) add("project", "clean", "Working tree", "warn", `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}). A run won't start until these are committed or stashed.`);
      else add("project", "clean", "Working tree", "ok", "Clean. Runs can start.");
      const remote = config.guardrails.remote;
      if (!config.guardrails.push) add("project", "remote", "Pushing", "info", "Pushing is turned off in the rules. Branches stay on this Mac.");
      else if (hasRemote(repo, remote)) add("project", "remote", "Pushing", "ok", `Passing cards push their branch to "${remote}".`);
      else add("project", "remote", "Pushing", "info", `No "${remote}" remote, so branches stay on this Mac until you add one.`);
    }

    const placeholder = config.verifiers.length === 1 && ["true", ":"].includes(config.verifiers[0].command.trim());
    if (placeholder) add("project", "checks", "Checks", "warn", "The only check is a placeholder that always passes, so Ungrind can't tell a working change from a broken one. Set your real test or build command in Edit Rules.");
    else add("project", "checks", "Checks", "ok", config.verifiers.map((v) => v.name).join(", "));

    if (config.taskSource.adapter === "local") {
      const dir = path.resolve(repo, config.taskSource.path);
      if (fs.existsSync(dir)) add("project", "cards", "Feature cards", "ok", `Local files in ${config.taskSource.path}/`);
      else add("project", "cards", "Feature cards", "fail", `The cards folder ${config.taskSource.path}/ doesn't exist.`, `mkdir -p ${config.taskSource.path}`);
    } else if (env[config.taskSource.tokenEnv]) add("project", "cards", "Feature cards", "ok", "Notion, token found.");
    else add("project", "cards", "Feature cards", "fail", `Cards come from Notion, but ${config.taskSource.tokenEnv} isn't set.`);

    // Every agent the route or review can call must be usable.
    const used = new Set(config.routing.ladder.map((t) => agentFor(config, null, t)));
    if (config.review.enabled) used.add(config.review.agent);
    const missing = [];
    if (used.has("claude-code") && !claudeReady) missing.push("Claude Code (not installed or not signed in)");
    if (used.has("codex") && !codexReady) missing.push("Codex (not installed)");
    if (used.has("ollama")) {
      const want = Object.values(config.agent.ollama?.models ?? {});
      if (!ollamaModels) missing.push("Ollama (not running)");
      else for (const m of want) if (!ollamaModels.includes(m) && !ollamaModels.includes(`${m}:latest`)) missing.push(`local model ${m} (not installed)`);
    }
    if (missing.length) add("project", "route", "Route", "fail", `The route uses tools that aren't ready: ${missing.join("; ")}.`);
    else add("project", "route", "Route", "ok", `${config.routing.ladder.join(" → ")} with ${[...used].join(", ")}`);

    const approved = fs.existsSync(config.prompts.conventions);
    const draft = fs.existsSync(draftPath(config)) ? draftPath(config) : null;
    conventions = { approved, path: config.prompts.conventions, draft };
    if (approved) add("project", "conventions", "Conventions", "ok", "Approved. Every run reads them.");
    else if (draft) add("project", "conventions", "Conventions", "warn", "A draft is waiting for your review. Read and edit it, then approve it.");
    else add("project", "conventions", "Conventions", "warn", "Not created yet. Ungrind can read the project and draft them for you to review. Until then, Ship asks before running without them.");
  }

  return { checks, ready: !checks.some((k) => k.status === "fail"), toolsReady: !checks.some((k) => k.scope === "tools" && k.status === "fail"), conventions };
}
