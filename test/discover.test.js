import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createSource } from "../src/sources/index.js";
import { loadTemplates } from "../src/prompts.js";
import { singleRunner } from "../src/agents/index.js";
import { initProject, saveCard, buildProjectState } from "../src/app.js";
import { parseDiscovery, discover } from "../src/discover.js";
import { readyCandidates } from "../src/task.js";

const reply = (cards) => `I read the repo.\n\n\`\`\`json\n${JSON.stringify({ cards }, null, 1)}\n\`\`\`\n`;
const CARDS = [
  { state: "shipped", title: "Capitalize", goal: "Strings can be capitalized.", criteria: ["capitalize('a') returns 'A'"], files: ["./src/strings.js"] },
  { state: "proposed", title: "Fix titleCase", goal: "titleCase handles every word.", criteria: ["all words capitalized"], files: ["src/strings.js"], size: "small", evidence: "Known bug comment in src/strings.js" },
  { state: "proposed", title: "Too broad", goal: "g", criteria: ["c"], files: ["**"] },
  { state: "proposed", title: "", goal: "", criteria: [], files: [] },
  { state: "proposed", title: "Existing card", goal: "g", criteria: ["c"], files: ["a.js"] },
  { state: "proposed", title: "Third", goal: "g", criteria: ["c"], files: ["b.js"], size: "huge" },
];

test("parseDiscovery reads fenced JSON, bare JSON, and rejects cards that fail the contract", () => {
  const { cards, rejected } = parseDiscovery(reply(CARDS));
  assert.deepEqual(cards.map((c) => c.title), ["Capitalize", "Fix titleCase", "Existing card", "Third"]);
  assert.deepEqual(cards[0].files, ["src/strings.js"]);
  assert.equal(cards[3].size, null);
  assert.deepEqual(rejected.map((r) => r.title), ["Too broad", "(untitled)"]);
  assert.equal(parseDiscovery(`Here: {"cards":[${JSON.stringify(CARDS[0])}]}`).cards.length, 1);
  assert.throws(() => parseDiscovery("I could not read the repo."), /did not return a list/);
});

test("discover writes shipped cards and drafts, skips duplicates, and drafts never enter the queue", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-disc-")));
  const config = loadConfig(initProject(dir).configFile);
  saveCard(config, { title: "Existing card", goal: "g", criteria: ["c"], files: ["a.js"], priority: 5 });
  const prompts = [];
  const runner = { async run({ prompt, readOnly, tier }) { prompts.push({ prompt, readOnly, tier }); return { output: reply(CARDS), exitCode: 0, usage: { costUsd: 0.2 }, durationMs: 5 }; } };
  const r = await discover({ config, source: createSource(config), runners: singleRunner(runner), templates: loadTemplates(config.prompts), max: 3 });

  assert.equal(prompts[0].readOnly, true);
  assert.equal(prompts[0].tier, "opus");
  assert.match(prompts[0].prompt, /- Existing card/);
  assert.match(prompts[0].prompt, /At most 3 cards/);
  assert.deepEqual(r.created, [{ id: "capitalize", title: "Capitalize", state: "shipped" }, { id: "fix-titlecase", title: "Fix titleCase", state: "proposed" }]);
  assert.deepEqual(r.skipped.map((s) => s.title), ["Existing card", "Third", "Too broad", "(untitled)"]);
  assert.equal(r.costUsd, 0.2);

  const state = await buildProjectState(config, createSource(config));
  const by = Object.fromEntries(state.cards.map((c) => [c.id, c]));
  assert.deepEqual([by.capitalize.status, by.capitalize.draft, by.capitalize.priority], ["done", false, 6]);
  assert.deepEqual([by["fix-titlecase"].status, by["fix-titlecase"].draft, by["fix-titlecase"].size], ["ready", true, "small"]);
  assert.match(by["fix-titlecase"].goal, /Evidence: Known bug comment/);
  assert.deepEqual(readyCandidates(await createSource(config).listTasks()).map((t) => t.id), ["existing-card"]);

  // Marking a draft ready (what the app's button does) puts it in the queue.
  saveCard(config, { ...by["fix-titlecase"], draft: false });
  assert.deepEqual(readyCandidates(await createSource(config).listTasks()).map((t) => t.id), ["existing-card", "fix-titlecase"]);

  // A second pass does not duplicate cards.
  const again = await discover({ config, source: createSource(config), runners: singleRunner(runner), templates: loadTemplates(config.prompts), max: 3 });
  assert.deepEqual(again.created, []);
});

test("discover surfaces a failed run", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-disc-")));
  const config = loadConfig(initProject(dir).configFile);
  const bad = { async run() { return { output: "not logged in", exitCode: 1, usage: { costUsd: 0 }, durationMs: 1 }; } };
  await assert.rejects(discover({ config, source: createSource(config), runners: singleRunner(bad), templates: loadTemplates(config.prompts) }), /first pass run failed \(exit 1\)/);
});
