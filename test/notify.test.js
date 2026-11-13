import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";
import { createNotifier, eventFor, formatMessage } from "../src/notify.js";

const cfg = (notify) =>
  validateConfig({ project: "demo", taskSource: { adapter: "local" }, verifiers: [{ name: "t", command: "true" }], gates: { notify } }).config;

test("eventFor maps run results to alert events", () => {
  assert.equal(eventFor({ result: "done" }), "done");
  assert.equal(eventFor({ result: "blocked", reason: "max attempts" }), "blocked");
  assert.equal(eventFor({ result: "blocked", reason: "cost ceiling hit ($3.10 >= $3)" }), "ceiling");
  assert.equal(eventFor({ result: "skipped" }), "skipped");
  assert.equal(eventFor({ result: "skipped-usage" }), "skipped");
  assert.equal(eventFor({ result: "nothing-ready" }), null);
  assert.equal(eventFor({ result: "done", dryRun: true }), null);
});

test("notifier posts to ntfy with title, tags, and auth", async () => {
  process.env.TEST_NTFY_TOKEN = "tok";
  const sent = [];
  const fetch = async (url, opts) => { sent.push({ url, ...opts }); return { ok: true }; };
  const notify = createNotifier(cfg({ ntfyTopic: "my topic", server: "https://ntfy.example/", tokenEnv: "TEST_NTFY_TOKEN", on: ["done", "blocked"] }), { fetch });
  const record = { result: "done", task: { title: "Add slugify" }, branch: "loop/add-slugify", attempts: [{ tier: "haiku" }, { tier: "sonnet" }], totalCostUsd: 0.42 };
  assert.equal(await notify("done", record), true);
  assert.equal(sent[0].url, "https://ntfy.example/my%20topic");
  assert.equal(sent[0].headers.Title, "[demo] done: Add slugify");
  assert.equal(sent[0].headers.Authorization, "Bearer tok");
  assert.match(sent[0].body, /attempts: 2 \(haiku → sonnet\)[\s\S]*\$0\.42/);
  assert.equal(await notify("skipped", record), false); // not in `on`
  assert.equal(sent.length, 1);
});

test("notifier is a no-op without a topic and never throws", async () => {
  assert.equal(await createNotifier(cfg({}), { fetch: () => { throw new Error("no"); } })("done", { result: "done" }), false);
  const logs = [];
  const notify = createNotifier(cfg({ ntfyTopic: "t" }), { fetch: async () => { throw new Error("offline"); }, log: (m) => logs.push(m) });
  assert.equal(await notify("blocked", { result: "blocked" }), false);
  assert.match(logs[0], /offline/);
  assert.match(formatMessage("blocked", { reason: "x" }, "p").title, /\[p\] blocked/);
});

test("config rejects unknown notify events", () => {
  const { errors } = validateConfig({ project: "p", taskSource: { adapter: "local" }, verifiers: [{ name: "t", command: "true" }], gates: { notify: { on: ["done", "exploded"] } } });
  assert.match(errors.join(), /gates\.notify\.on/);
});
