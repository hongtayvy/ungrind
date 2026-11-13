import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateConfig } from "../src/config.js";
import { createSource } from "../src/sources/index.js";
import { writeRunLog } from "../src/runlog.js";
import { buildState, renderHtml, serveBoard, writeBoard } from "../src/board.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-board-"));
  fs.mkdirSync(path.join(dir, "tasks"));
  const card = (title, status, extra = "") => `---\ntitle: ${title}\nstatus: ${status}\npriority: 1\nfiles: [a.js]\n${extra}---\n## Goal\ng\n## Acceptance criteria\n- c\n`;
  fs.writeFileSync(path.join(dir, "tasks/a.md"), card("Alpha <script>", "Ready"));
  fs.writeFileSync(path.join(dir, "tasks/b.md"), card("Beta", "Ready", "dependencies: [d]\n"));
  fs.writeFileSync(path.join(dir, "tasks/c.md"), card("Gamma", "Done") + "\n## Summary\n\n_2026_\n\nAdded gamma.\n");
  fs.writeFileSync(path.join(dir, "tasks/d.md"), "---\ntitle: Vague\nstatus: Blocked\npriority: 2\n---\nstuff\n");
  const { config } = validateConfig({ project: "Board<Test>", repo: dir, taskSource: { adapter: "local" }, verifiers: [{ name: "t", command: "true" }] });
  writeRunLog(config.prompts.stateDir, { ts: "2026-11-13T10:00:00.000Z", task: { title: "Gamma" }, result: "done", branch: "loop/gamma", totalCostUsd: 0.02, durationMs: 5000, attempts: [{ tier: "local", agent: "ollama", passed: false }, { tier: "haiku", agent: "claude-code", passed: true }] });
  writeRunLog(config.prompts.stateDir, { ts: "2026-11-13T11:00:00.000Z", result: "nothing-ready", attempts: [] });
  return { dir, config };
}

test("state groups tasks into columns and summarizes runs", async () => {
  const { config } = setup();
  const s = await buildState(config, createSource(config));
  assert.deepEqual(Object.fromEntries(Object.entries(s.columns).map(([k, v]) => [k, v.map((c) => c.title)])), { ready: ["Alpha <script>", "Beta"], in_progress: [], blocked: ["Vague"], done: ["Gamma"] });
  assert.equal(s.columns.ready[0].waiting, false);
  assert.equal(s.columns.ready[1].waiting, true); // depends on d, which is blocked
  assert.equal(s.columns.blocked[0].problems.length > 0, true);
  assert.equal(s.columns.done[0].summary.includes("Added gamma."), true);
  assert.equal(s.runs.length, 1); // nothing-ready runs are hidden
  assert.equal(s.runs[0].path, "local✗ → haiku✓");
  assert.equal(s.runs[0].agents, "ollama, claude-code");
});

test("html escapes task content", async () => {
  const { config } = setup();
  const html = renderHtml(await buildState(config, createSource(config)));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Alpha &lt;script&gt;/);
  assert.match(html, /Board&lt;Test&gt;/);
  assert.match(html, /local✗ → haiku✓/);
});

test("server is GET-only on localhost and never modifies tasks", async () => {
  const { dir, config } = setup();
  const before = fs.readdirSync(path.join(dir, "tasks")).map((f) => fs.readFileSync(path.join(dir, "tasks", f), "utf8"));
  const server = await serveBoard(config, createSource(config), { port: 0 });
  const { address, port } = server.address();
  try {
    assert.equal(address, "127.0.0.1");
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /http-equiv="refresh"/);
    const api = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(api.columns.done[0].title, "Gamma");
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
  } finally {
    server.close();
  }
  const after = fs.readdirSync(path.join(dir, "tasks")).map((f) => fs.readFileSync(path.join(dir, "tasks", f), "utf8"));
  assert.deepEqual(after, before);
  const out = await writeBoard(config, createSource(config), path.join(dir, "board.html"));
  assert.match(fs.readFileSync(out, "utf8"), /^<!DOCTYPE html>/);
});
