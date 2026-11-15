import fs from "node:fs";
import path from "node:path";
import { commandCheck } from "../verifiers/index.js";

/**
 * Ollama adapter: a local model behind the same runner interface.
 * Ollama serves models, not agents, so this adapter runs a small tool loop over
 * POST /api/chat with tool calling. Tools are sandboxed to the repo:
 *   list_files, read_file, write_file, replace_in_file, run_checks (the configured verifiers only).
 * No shell access. Cost is always $0. Ungrind never pulls models: a missing model is an error.
 *
 * Config (agent.ollama):
 *   host: http://127.0.0.1:11434
 *   models: { local: "qwen3.6-coding-16k:latest" }   # tier -> installed model
 *   maxTurns: 40
 *   think: false        # let thinking models think (slower)
 *   numCtx: null        # override the model's context window
 */

const SKIP_DIRS = new Set([".git", "node_modules", ".ungrind"]);
const MAX_READ = 40_000;

const SYSTEM = `You are a careful coding agent running on a local machine with tools.
Work only through the tools. Read files before editing them. Prefer replace_in_file for small edits.
Run run_checks before finishing and fix failures. When finished, reply with your final message (no tool call).`;

function tool(name, description, properties = {}, required = Object.keys(properties)) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}
const str = (description) => ({ type: "string", description });

const TOOLS = {
  list_files: tool("list_files", "List files under a folder of the repository (recursive).", { dir: str("Repo-relative folder, '.' for the root") }),
  read_file: tool("read_file", "Read a text file from the repository.", { path: str("Repo-relative file path") }),
  write_file: tool("write_file", "Create or overwrite a file with the full new content.", { path: str("Repo-relative file path"), content: str("Full file content") }),
  replace_in_file: tool("replace_in_file", "Replace one exact, unique occurrence of old_text with new_text in a file.", {
    path: str("Repo-relative file path"), old_text: str("Exact text to replace; must occur once"), new_text: str("Replacement text"),
  }),
  run_checks: tool("run_checks", "Run the project's configured checks (tests, lint, build) and return their output.", {}, []),
};

export class OllamaRunner {
  constructor(cfg = {}, { fetch = globalThis.fetch } = {}) {
    this.host = (cfg.host ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.maxTurns = cfg.maxTurns ?? 40;
    this.think = cfg.think ?? false;
    this.numCtx = cfg.numCtx ?? null;
    this.unsetEnv = cfg.unsetEnv ?? [];
    this.fetch = fetch;
  }

  async installedModels() {
    const res = await this.fetch(`${this.host}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()).models ?? []).map((m) => m.name);
  }

  async run({ prompt, cwd, model, timeoutMs, readOnly = false, checks = [] }) {
    const started = Date.now();
    const usage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const done = (output, exitCode, timedOut = false) => ({ output, exitCode, usage, durationMs: Date.now() - started, timedOut });

    let installed;
    try { installed = await this.installedModels(); }
    catch (e) { return done(`Ollama is not reachable at ${this.host} (${e.message}). Start it with \`ollama serve\`.`, 127); }
    const want = model.includes(":") ? model : `${model}:latest`;
    if (!installed.includes(model) && !installed.includes(want)) {
      return done(`Ollama model "${model}" is not installed. Installed: ${installed.join(", ") || "(none)"}. Ungrind never pulls models; run \`ollama pull ${model}\` yourself if you want it.`, 127);
    }

    const tools = readOnly ? [TOOLS.list_files, TOOLS.read_file] : Object.values(TOOLS);
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }];
    const deadline = started + timeoutMs;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return done(`Timed out after ${Math.round(timeoutMs / 1000)}s`, 124, true);
      let data;
      try {
        const res = await this.fetch(`${this.host}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, tools, stream: false, think: this.think, options: { temperature: 0.2, ...(this.numCtx ? { num_ctx: this.numCtx } : {}) } }),
          signal: AbortSignal.timeout(remaining),
        });
        data = await res.json();
        if (!res.ok) return done(`Ollama /api/chat failed: ${res.status} ${data.error ?? ""}`, 1);
      } catch (e) {
        const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
        return done(timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : `Ollama request failed: ${e.message}`, timedOut ? 124 : 1, timedOut);
      }
      usage.inputTokens += data.prompt_eval_count ?? 0;
      usage.outputTokens += data.eval_count ?? 0;
      const msg = data.message ?? { role: "assistant", content: "" };
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (!calls.length) return done(stripThinking(msg.content ?? ""), 0);
      for (const call of calls) {
        const name = call.function?.name;
        let result;
        try {
          if (!tools.some((t) => t.function.name === name)) throw new Error(`unknown or unavailable tool: ${name}`);
          result = await this.exec(name, parseArgs(call.function.arguments), { cwd, checks });
        } catch (e) {
          result = `ERROR: ${e.message}`;
        }
        messages.push({ role: "tool", tool_name: name, content: result });
      }
    }
    return done(`Local model used all ${this.maxTurns} turns without finishing.`, 1);
  }

  async exec(name, args, { cwd, checks }) {
    switch (name) {
      case "list_files": {
        const root = safePath(cwd, args.dir ?? ".");
        const out = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (out.length >= 500) return;
            if (SKIP_DIRS.has(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else out.push(path.relative(cwd, p).split(path.sep).join("/"));
          }
        };
        walk(root);
        return out.join("\n") || "(empty)";
      }
      case "read_file": {
        const text = fs.readFileSync(safePath(cwd, args.path), "utf8");
        return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[...truncated at ${MAX_READ} chars]` : text;
      }
      case "write_file": {
        const p = safePath(cwd, args.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args.content ?? ""));
        return `wrote ${args.path}`;
      }
      case "replace_in_file": {
        const p = safePath(cwd, args.path);
        const text = fs.readFileSync(p, "utf8");
        const count = text.split(String(args.old_text)).length - 1;
        if (count !== 1) throw new Error(`old_text must occur exactly once in ${args.path}; found ${count}`);
        fs.writeFileSync(p, text.replace(String(args.old_text), () => String(args.new_text ?? "")));
        return `edited ${args.path}`;
      }
      case "run_checks": {
        if (!checks.length) return "No checks configured.";
        const parts = [];
        for (const c of checks) {
          const r = await commandCheck(c, cwd, { unsetEnv: this.unsetEnv });
          parts.push(`## ${r.name}: ${r.passed ? "PASS" : "FAIL"}\n${r.output}`);
          if (!r.passed) break;
        }
        return parts.join("\n\n");
      }
    }
    throw new Error(`unknown tool ${name}`);
  }
}

/** Resolve a repo-relative path; refuse anything that escapes the repo or touches .git. */
export function safePath(cwd, rel) {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
  const abs = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes the repository: ${rel}`);
  if (path.relative(root, abs).split(path.sep).includes(".git")) throw new Error("the .git folder is off-limits");

  // Follow symlinks before trusting the path: a link inside the repo must not lead outside it.
  const realRoot = fs.realpathSync(root);
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  let probe = abs;
  while (true) {
    let st = null;
    try { st = fs.lstatSync(probe); } catch { /* does not exist yet */ }
    if (st) {
      if (st.isSymbolicLink()) {
        let real;
        try { real = fs.realpathSync(probe); } catch { throw new Error(`refusing to follow a broken symbolic link: ${rel}`); }
        if (!inside(real)) throw new Error(`path escapes the repository through a symbolic link: ${rel}`);
        probe = real;
      }
      const real = fs.realpathSync(probe);
      if (!inside(real)) throw new Error(`path escapes the repository through a symbolic link: ${rel}`);
      if (path.relative(realRoot, real).split(path.sep).includes(".git")) throw new Error("the .git folder is off-limits");
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return abs;
}

function parseArgs(a) {
  if (a && typeof a === "object") return a;
  try { return JSON.parse(a); } catch { return {}; }
}

const stripThinking = (s) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
