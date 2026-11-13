import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateConfig } from "../src/config.js";
import { agentFor, modelFor, createRunners } from "../src/agents/index.js";
import { CodexRunner, parseCodexJsonl } from "../src/agents/codex.js";
import { OllamaRunner, safePath } from "../src/agents/ollama.js";
import { createSource } from "../src/sources/index.js";
import { loadTemplates } from "../src/prompts.js";
import { runOnce } from "../src/engine.js";
import { readRunLog, passRateByPromptVersion, statsByTier } from "../src/runlog.js";

const base = (extra = {}) => ({ project: "p", taskSource: { adapter: "local" }, verifiers: [{ name: "t", command: "true" }], ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-agents-"));

test("routing: byTier beats byType beats default; models per adapter", () => {
  const { config, errors } = validateConfig(base({
    routing: { ladder: ["local", "haiku", "sonnet", "opus"], tierBySize: { small: "local" } },
    agent: { byTier: { local: "ollama" }, byType: { ui: "codex" }, ollama: { models: { local: "qwen3.5:4b" } }, codex: { models: { sonnet: "codex-model" } } },
  }));
  assert.deepEqual(errors, []);
  assert.equal(agentFor(config, { type: "ui" }, "local"), "ollama");
  assert.equal(agentFor(config, { type: "ui" }, "sonnet"), "codex");
  assert.equal(agentFor(config, { type: "api" }, "sonnet"), "claude-code");
  assert.equal(modelFor(config, "ollama", "local"), "qwen3.5:4b");
  assert.equal(modelFor(config, "codex", "sonnet"), "codex-model");
  assert.equal(modelFor(config, "codex", "opus"), null); // codex default model
  assert.equal(modelFor(config, "claude-code", "haiku"), "claude-haiku-5-5");
});

test("config: local tier needs an ollama model and adapters must be known", () => {
  const { errors } = validateConfig(base({ routing: { ladder: ["local", "haiku"] }, agent: { byTier: { local: "ollama", turbo: "gpt" } } }));
  const text = errors.join("\n");
  assert.match(text, /tier "local" runs on ollama but has no model in agent\.ollama\.models/);
  assert.match(text, /unknown adapter "gpt"/);
  assert.match(text, /agent\.byTier\.turbo: "turbo" is not on the ladder/);
});

test("codex: JSONL parsing takes the last agent message and sums usage", () => {
  const out = [
    { type: "thread.started", thread_id: "x" },
    { type: "item.completed", item: { type: "agent_message", text: "first" } },
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100, reasoning_output_tokens: 50 } },
    { type: "item.completed", item: { type: "agent_message", text: "done\nUNGRIND_SUMMARY: x" } },
    "not json",
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  const r = parseCodexJsonl(out, { inputPerMTok: 1, outputPerMTok: 10 });
  assert.equal(r.output, "done\nUNGRIND_SUMMARY: x");
  assert.deepEqual(r.usage, { costUsd: 0.0025, inputTokens: 1000, outputTokens: 150 });
  assert.equal(parseCodexJsonl(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })).failed, true);
});

test("codex runner: exact headless args, prompt on stdin, missing binary is exit 127", async () => {
  const dir = tmp();
  const bin = path.join(dir, "fake-codex");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin"\necho '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'\necho '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}'\n`);
  fs.chmodSync(bin, 0o755);
  const r = await new CodexRunner({}, { bin }).run({ prompt: "do it", cwd: dir, model: "m1", timeoutMs: 5000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, "ok");
  assert.equal(fs.readFileSync(`${dir}/args`, "utf8").trim(), `exec --json --ephemeral --skip-git-repo-check -C ${dir} -s workspace-write -m m1 -`);
  assert.equal(fs.readFileSync(`${dir}/stdin`, "utf8"), "do it");
  const ro = new CodexRunner().buildArgs({ cwd: "/r", model: null, readOnly: true });
  assert.deepEqual(ro, ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", "/r", "-s", "read-only", "-"]);
  assert.equal((await new CodexRunner({}, { bin: path.join(dir, "nope") }).run({ prompt: "", cwd: dir, timeoutMs: 1000 })).exitCode, 127);
});

/** Fake Ollama server: /api/tags lists models; /api/chat replays scripted assistant messages. */
function fakeOllama(installed, script) {
  const chats = [];
  return {
    chats,
    fetch: async (url, opts) => {
      if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: installed.map((name) => ({ name })) }) };
      const body = JSON.parse(opts.body);
      chats.push(body);
      const message = script[chats.length - 1];
      return { ok: true, json: async () => ({ message, prompt_eval_count: 100, eval_count: 20 }) };
    },
  };
}
const call = (name, args) => ({ function: { name, arguments: args } });

test("ollama runner: tool loop edits files, runs checks, reports $0 cost", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/a.txt"), "hello old\n");
  const o = fakeOllama(["qwen3.5:4b"], [
    { role: "assistant", content: "", tool_calls: [call("read_file", { path: "src/a.txt" }), call("list_files", { dir: "." })] },
    { role: "assistant", content: "", tool_calls: [call("replace_in_file", JSON.stringify({ path: "src/a.txt", old_text: "old", new_text: "new" }))] },
    { role: "assistant", content: "", tool_calls: [call("write_file", { path: "../escape.txt", content: "x" }), call("run_checks", {})] },
    { role: "assistant", content: "<think>hmm</think>Done.\nUNGRIND_SUMMARY: replaced old" },
  ]);
  const runner = new OllamaRunner({ host: "http://ollama.test" }, { fetch: o.fetch });
  const checks = [{ name: "has new", command: "grep -q new src/a.txt", cwd: ".", timeoutSec: 5, pass: { exitCode: 0 } }];
  const r = await runner.run({ prompt: "change it", cwd: dir, model: "qwen3.5:4b", timeoutMs: 10_000, checks });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, "Done.\nUNGRIND_SUMMARY: replaced old");
  assert.deepEqual(r.usage, { costUsd: 0, inputTokens: 400, outputTokens: 80 });
  assert.equal(fs.readFileSync(path.join(dir, "src/a.txt"), "utf8"), "hello new\n");
  assert.equal(fs.existsSync(path.join(dir, "..", "escape.txt")), false);
  const toolMsgs = o.chats[3].messages.filter((m) => m.role === "tool");
  assert.match(toolMsgs[0].content, /hello old/);
  assert.match(toolMsgs[3].content, /ERROR: path escapes the repository/);
  assert.match(toolMsgs[4].content, /has new: PASS/);
  assert.equal(o.chats[0].model, "qwen3.5:4b");
  assert.equal(o.chats[0].stream, false);
  assert.deepEqual(o.chats[0].tools.map((t) => t.function.name), ["list_files", "read_file", "write_file", "replace_in_file", "run_checks"]);
});

test("ollama runner: never pulls a missing model, read-only hides write tools, turn limit", async () => {
  const dir = tmp();
  const missing = await new OllamaRunner({}, { fetch: fakeOllama(["qwen3.5:4b"], []).fetch }).run({ prompt: "x", cwd: dir, model: "llama9:70b", timeoutMs: 1000 });
  assert.equal(missing.exitCode, 127);
  assert.match(missing.output, /not installed[\s\S]*never pulls/);
  const o = fakeOllama(["qwen3.6-coding-16k:latest"], [{ role: "assistant", content: "", tool_calls: [call("list_files", {})] }]);
  const r = await new OllamaRunner({ maxTurns: 1 }, { fetch: o.fetch }).run({ prompt: "x", cwd: dir, model: "qwen3.6-coding-16k", timeoutMs: 1000, readOnly: true });
  assert.deepEqual(o.chats[0].tools.map((t) => t.function.name), ["list_files", "read_file"]);
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /used all 1 turns/);
  const down = await new OllamaRunner({}, { fetch: async () => { throw new Error("ECONNREFUSED"); } }).run({ prompt: "x", cwd: dir, model: "m", timeoutMs: 1000 });
  assert.match(down.output, /not reachable/);
  assert.throws(() => safePath(dir, ".git/config"), /off-limits/);
  assert.throws(() => safePath(dir, "/etc/passwd"), /escapes/);
});

test("engine: local tier first, escalates to haiku, logs $0 for local attempts", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "tasks"));
  fs.writeFileSync(path.join(dir, "v.txt"), "old\n");
  fs.writeFileSync(path.join(dir, "tasks/a.md"), "---\ntitle: Set v\nstatus: Ready\npriority: 1\nsize: small\nfiles: [v.txt]\n---\n## Goal\nv is new\n## Acceptance criteria\n- v is new\n");
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"], { cwd: dir });
  const { config, errors } = validateConfig(base({
    repo: dir, verifiers: [{ name: "v", command: "grep -q '^new$' v.txt" }],
    guardrails: { push: false }, prompts: { requireConventions: false },
    routing: { ladder: ["local", "haiku", "sonnet", "opus"], tierBySize: { small: "local" } },
    agent: { byTier: { local: "ollama" }, ollama: { models: { local: "qwen3.6-coding-16k:latest" } } },
  }));
  assert.deepEqual(errors, []);
  const calls = [];
  const local = { async run({ model, cwd }) { calls.push(["ollama", model]); fs.writeFileSync(path.join(cwd, "v.txt"), "wrong\n"); return { output: "tried", exitCode: 0, usage: { costUsd: 0, inputTokens: 900, outputTokens: 50 }, durationMs: 1 }; } };
  const claude = { async run({ model, cwd }) { calls.push(["claude-code", model]); fs.writeFileSync(path.join(cwd, "v.txt"), "new\n"); return { output: "UNGRIND_SUMMARY: fixed", exitCode: 0, usage: { costUsd: 0.02 }, durationMs: 1 }; } };
  const r = await runOnce({ config, source: createSource(config), runners: createRunners(config, { ollama: local, "claude-code": claude }), templates: loadTemplates(config.prompts), log: () => {} });
  assert.equal(r.result, "done");
  assert.deepEqual(calls, [["ollama", "qwen3.6-coding-16k:latest"], ["ollama", "qwen3.6-coding-16k:latest"], ["claude-code", "claude-haiku-5-5"]]);
  const logged = readRunLog(config.prompts.stateDir)[0];
  assert.deepEqual(logged.attempts.map((a) => [a.tier, a.agent, a.costUsd]), [["local", "ollama", 0], ["local", "ollama", 0], ["haiku", "claude-code", 0.02]]);
  assert.equal(logged.attempts[0].tokens.input, 900);
  assert.equal(logged.totalCostUsd, 0.02);
});

test("statsByTier compares local and paid tiers per attempt", () => {
  const s = statsByTier([
    { attempts: [{ tier: "local", agent: "ollama", model: "q", costUsd: 0, passed: false, agentMs: 2000 }, { tier: "haiku", agent: "claude-code", model: "h", costUsd: 0.01, passed: true, agentMs: 1000 }] },
    { attempts: [{ tier: "local", agent: "ollama", model: "q", costUsd: 0, passed: true, agentMs: 4000 }] },
    { dryRun: true, attempts: [{ tier: "local", agent: "ollama", model: "q", passed: true }] },
  ]);
  assert.deepEqual(s["local / ollama / q"], { attempts: 2, passed: 1, costUsd: 0, agentMs: 6000 });
  assert.deepEqual(s["haiku / claude-code / h"], { attempts: 1, passed: 1, costUsd: 0.01, agentMs: 1000 });
});
