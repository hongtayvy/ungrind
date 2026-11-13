import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, parseFrontMatter } from "../src/yaml.js";
import { matchesPattern } from "../src/glob.js";
import { validateConfig } from "../src/config.js";
import { validateTask, readyCandidates, slugify } from "../src/task.js";
import { parseResult } from "../src/agents/claude-code.js";
import { parseAgentOutput, fill } from "../src/prompts.js";
import { NotionSource } from "../src/sources/notion.js";
import { passRateByPromptVersion } from "../src/runlog.js";

test("yaml: nested maps, lists of maps, flow lists, comments, block scalars", () => {
  const y = parseYaml(`
project: demo # comment
taskSource:
  adapter: local
  statuses: { ready: Ready, done: "Done" }
verifiers:
  - name: tests
    command: npm test
    timeoutSec: 30
  - name: lint
    command: "echo '#not a comment'"
tags: [a, "b, c", 3]
list:
- x
- y
desc: |
  line one
  line two
empty:
`);
  assert.equal(y.project, "demo");
  assert.deepEqual(y.taskSource.statuses, { ready: "Ready", done: "Done" });
  assert.equal(y.verifiers[0].timeoutSec, 30);
  assert.equal(y.verifiers[1].command, "echo '#not a comment'");
  assert.deepEqual(y.tags, ["a", "b, c", 3]);
  assert.deepEqual(y.list, ["x", "y"]);
  assert.equal(y.desc, "line one\nline two");
  assert.equal(y.empty, null);
});

test("front matter split", () => {
  const { data, body } = parseFrontMatter("---\ntitle: X\nfiles: [a.js]\n---\n## Goal\nDo it\n");
  assert.equal(data.title, "X");
  assert.deepEqual(data.files, ["a.js"]);
  assert.match(body, /## Goal/);
});

test("glob matching", () => {
  assert.ok(matchesPattern("src/a/b.js", "src"));
  assert.ok(matchesPattern("src/a/b.js", "src/**/*.js"));
  assert.ok(matchesPattern("src/b.js", "src/**/*.js"));
  assert.ok(matchesPattern(".env.local", ".env.*"));
  assert.ok(matchesPattern("app/secrets/key.txt", "**/secrets/**"));
  assert.ok(!matchesPattern("srcx/a.js", "src"));
  assert.ok(!matchesPattern("src/a.ts", "src/*.js"));
});

test("config validation reports every problem", () => {
  const { errors } = validateConfig({ taskSource: { adapter: "jira" }, routing: { ladder: ["haiku", "gpt"] }, guardrails: { branchPattern: "loop" } });
  const text = errors.join("\n");
  assert.match(text, /project: required/);
  assert.match(text, /adapter: must be/);
  assert.match(text, /at least one check/);
  assert.match(text, /\{slug\}/);
  assert.match(text, /"gpt" has no model/);
});

test("config defaults applied", () => {
  const { config, errors } = validateConfig({ project: "p", taskSource: { adapter: "local" }, verifiers: [{ name: "t", command: "true" }] });
  assert.deepEqual(errors, []);
  assert.equal(config.verifiers[0].timeoutSec, 300);
  assert.equal(config.verifiers[0].pass.exitCode, 0);
  assert.deepEqual(config.routing.ladder, ["haiku", "sonnet", "opus"]);
  assert.equal(config.taskSource.path, "tasks");
});

test("task contract", () => {
  const ok = { title: "T", goal: "G", criteria: ["c"], files: ["src"], status: "ready", priority: 1, dependencies: [] };
  assert.deepEqual(validateTask(ok), []);
  const bad = validateTask({ title: "", goal: "", criteria: [], files: ["**"], status: "ready", priority: NaN });
  assert.equal(bad.length, 5);
  assert.deepEqual(validateTask({ ...ok, files: ["../x"] }), ["files in scope must be repo-relative: ../x"]);
});

test("queue: priority order and dependencies", () => {
  const t = (id, status, priority, dependencies = []) => ({ id, status, priority, dependencies });
  const ids = readyCandidates([t("a", "ready", 2), t("b", "ready", 1, ["c"]), t("c", "done", 9), t("d", "ready", 0, ["a"]), t("e", "blocked", 0)]).map((x) => x.id);
  assert.deepEqual(ids, ["b", "a"]);
  assert.equal(slugify("Add /health endpoint!"), "add-health-endpoint");
});

test("claude json result parsing", () => {
  const r = parseResult(JSON.stringify({ result: "ok", total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5 } }), "", 0);
  assert.equal(r.output, "ok");
  assert.equal(r.usage.costUsd, 0.12);
  assert.equal(parseResult("not json", "err", 1).isError, true);
});

test("agent output markers and slot filling", () => {
  assert.deepEqual(parseAgentOutput("work\nUNGRIND_SUMMARY:\n- did x"), { blocked: null, summary: "- did x" });
  assert.equal(parseAgentOutput("UNGRIND_BLOCKED: unclear spec").blocked, "unclear spec");
  assert.equal(fill("a {{x}} b", { x: 1 }), "a 1 b");
  assert.throws(() => fill("{{missing}}", {}), /Unfilled/);
});

test("notion adapter maps properties and statuses", async () => {
  const calls = [];
  const page = {
    id: "p1",
    properties: {
      Name: { title: [{ plain_text: "Fix login" }] },
      Goal: { rich_text: [{ plain_text: "Login works" }] },
      "Acceptance criteria": { rich_text: [{ plain_text: "- a\n- b" }] },
      "Files in scope": { rich_text: [{ plain_text: "src/auth, test/auth.test.js" }] },
      Status: { status: { name: "Todo" } },
      Priority: { number: 2 },
      Dependencies: { relation: [{ id: "p0" }] },
      Size: { select: { name: "small" } },
    },
  };
  const fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body && JSON.parse(opts.body) });
    return { ok: true, json: async () => (url.endsWith("/query") ? { results: [page], has_more: false } : {}) };
  };
  const src = new NotionSource({ taskSource: { databaseId: "db", statuses: { ready: "Todo", in_progress: "Doing", done: "Done", blocked: "Stuck" } } }, { fetch, token: "x" });
  const [t] = await src.listTasks();
  assert.equal(t.status, "ready");
  assert.deepEqual(t.criteria, ["a", "b"]);
  assert.deepEqual(t.files, ["src/auth", "test/auth.test.js"]);
  assert.deepEqual(t.dependencies, ["p0"]);
  assert.deepEqual(validateTask(t), []);
  await src.setStatus(t, "done");
  assert.deepEqual(calls[1].body, { properties: { Status: { status: { name: "Done" } } } });
  await src.attach(t, "summary", "changed x");
  assert.match(calls[2].body.children[0].paragraph.rich_text[0].text.content, /^\[ungrind:summary\]/);
});

test("pass rate by prompt version", () => {
  const rows = passRateByPromptVersion([
    { promptVersion: "v1+a", result: "done", attempts: [{}] },
    { promptVersion: "v1+a", result: "done", attempts: [{}, {}] },
    { promptVersion: "v1+a", result: "blocked", attempts: [{}] },
    { promptVersion: "v1+a", result: "done", attempts: [{}], dryRun: true },
  ]);
  assert.deepEqual(rows["v1+a"], { runs: 3, firstTryPass: 1, passed: 2 });
});
