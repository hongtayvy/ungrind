import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { initProject } from "../src/app.js";
import { saveRules, getRules } from "../src/rules.js";
import { doctor } from "../src/doctor.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-doc-")));
const down = async () => { throw new Error("down"); };
const ollama = (models) => async () => ({ ok: true, json: async () => ({ models: models.map((name) => ({ name })) }) });

/** Fake tool runner: `tools` maps a command to its result; anything else is "not found". */
function fakeExec(tools) {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const hit = tools[key] ?? tools[cmd];
    return hit ? { code: 0, stdout: hit, stderr: "" } : { code: 127, stdout: "", stderr: "" };
  };
}
const signedIn = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "someone@example.com" });
const ALL = { git: "git version 2.54.0", "claude --version": "2.1.0 (Claude Code)", "claude auth status --json": signedIn };
const by = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test("tools: everything ready, and the report never includes the account email", async () => {
  const r = await doctor({ exec: fakeExec(ALL), fetch: ollama(["qwen:latest"]), env: {}, nodeVersion: "24.4.0" });
  const c = by(r);
  assert.equal(r.ready, true);
  assert.equal(r.toolsReady, true);
  assert.deepEqual([c.node.status, c.git.status, c.claude.status, c["claude-login"].status, c.ollama.status, c.codex.status], ["ok", "ok", "ok", "ok", "ok", "info"]);
  assert.match(c["claude-login"].detail, /Claude subscription \(Pro\)/);
  assert.doesNotMatch(JSON.stringify(r), /someone@example\.com/);
});

test("tools: missing or signed-out tools fail with a fix", async () => {
  let r = await doctor({ exec: fakeExec({}), fetch: down, env: {}, nodeVersion: "18.0.0" });
  let c = by(r);
  assert.equal(r.ready, false);
  assert.deepEqual([c.node.status, c.git.status, c.claude.status, c.ollama.status], ["fail", "fail", "fail", "info"]);
  assert.equal(c.claude.fix, "npm install -g @anthropic-ai/claude-code");
  assert.equal(c["claude-login"], undefined);

  r = await doctor({ exec: fakeExec({ ...ALL, "claude auth status --json": JSON.stringify({ loggedIn: false }) }), fetch: down, env: {}, nodeVersion: "22.0.0" });
  assert.deepEqual([by(r)["claude-login"].status, by(r)["claude-login"].fix], ["fail", "claude auth login"]);

  r = await doctor({ exec: fakeExec(ALL), fetch: down, env: { ANTHROPIC_API_KEY: "x" }, nodeVersion: "22.0.0" });
  assert.equal(by(r)["claude-login"].status, "warn");
  assert.match(by(r)["claude-login"].detail, /billed to that API key/);
  assert.equal(r.ready, true);
});

test("project: fresh folder needs a repo; then reports tree, checks, pushing, and conventions", async () => {
  const dir = tmp();
  const file = initProject(dir).configFile;
  const opts = { exec: fakeExec(ALL), fetch: down, env: {}, nodeVersion: "22.0.0" };
  let c = by(await doctor({ config: loadConfig(file), ...opts }));
  assert.equal(c.repo.status, "fail");
  assert.match(c.repo.fix, /git init/);
  assert.equal(c.checks.status, "warn"); // placeholder check
  assert.equal(c.conventions.status, "warn");

  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "new.txt"), "x");
  let r = await doctor({ config: loadConfig(file), ...opts });
  c = by(r);
  assert.deepEqual([c.repo.status, c.clean.status, c.remote.status, c.route.status, c.cards.status], ["ok", "warn", "info", "ok", "ok"]);
  assert.match(c.clean.detail, /1 uncommitted change \(new\.txt\)/);
  assert.equal(r.ready, true);
  assert.deepEqual(r.conventions, { approved: false, path: path.join(dir, ".ungrind", "conventions.md"), draft: null });

  fs.mkdirSync(path.join(dir, ".ungrind"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ungrind", "conventions.draft.md"), "draft");
  r = await doctor({ config: loadConfig(file), ...opts });
  assert.match(by(r).conventions.detail, /draft is waiting/);
  assert.ok(r.conventions.draft.endsWith("conventions.draft.md"));
  fs.renameSync(path.join(dir, ".ungrind", "conventions.draft.md"), path.join(dir, ".ungrind", "conventions.md"));
  assert.equal(by(await doctor({ config: loadConfig(file), ...opts })).conventions.status, "ok");
});

test("project: a route that needs a missing tool fails; a broken rules file is reported", async () => {
  const dir = tmp();
  const file = initProject(dir).configFile;
  const { rules } = await getRules(loadConfig(file), { fetch: down });
  saveRules(file, { ...rules, ladder: ["local", "haiku", "sonnet", "opus"], localModel: "qwen:latest", review: { enabled: true, agent: "codex", blocking: true } });
  const opts = { exec: fakeExec(ALL), env: {}, nodeVersion: "22.0.0" };
  let c = by(await doctor({ config: loadConfig(file), fetch: down, ...opts }));
  assert.equal(c.route.status, "fail");
  assert.match(c.route.detail, /Codex \(not installed\); Ollama \(not running\)/);
  c = by(await doctor({ config: loadConfig(file), fetch: ollama(["other:latest"]), ...opts }));
  assert.match(c.route.detail, /local model qwen:latest \(not installed\)/);
  c = by(await doctor({ config: loadConfig(file), fetch: ollama(["qwen:latest"]), exec: fakeExec({ ...ALL, codex: "codex-cli 0.169.0" }), env: {}, nodeVersion: "22.0.0" }));
  assert.equal(c.route.status, "ok");

  const r = await doctor({ configError: "Invalid config: project: required string", ...opts, fetch: down });
  assert.deepEqual([by(r).rules.status, r.ready, r.toolsReady], ["fail", false, true]);
});
