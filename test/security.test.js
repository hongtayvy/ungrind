import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { validateConfig } from "../src/config.js";
import { OllamaRunner, safePath } from "../src/agents/ollama.js";
import { childEnv, spawnAgent } from "../src/agents/spawn.js";
import { commandCheck } from "../src/verifiers/index.js";
import { createSource } from "../src/sources/index.js";
import { serveBoard } from "../src/board.js";
import { writeRunLog } from "../src/runlog.js";
import { loadConfig } from "../src/config.js";
import { initProject } from "../src/app.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ungrind-sec-")));

test("local model file tools cannot escape the repo through symbolic links", async () => {
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET\n");
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "src"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.symlinkSync(outside, path.join(repo, "link"));                       // folder outside
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "file-link")); // file outside
  fs.symlinkSync(path.join(outside, "nope.txt"), path.join(repo, "broken"));      // dangling
  fs.symlinkSync(path.join(repo, ".git"), path.join(repo, "to-git"));             // into .git
  fs.symlinkSync(path.join(repo, "src"), path.join(repo, "inside"));              // harmless

  for (const bad of ["link", "link/secret.txt", "link/new.txt", "file-link", "broken", "to-git", "to-git/config", "../outside.txt", "/etc/passwd", ".git/config"]) {
    assert.throws(() => safePath(repo, bad), /escapes|off-limits|broken symbolic link/, bad);
  }
  assert.doesNotThrow(() => safePath(repo, "inside"));
  assert.doesNotThrow(() => safePath(repo, "inside/new.js"));
  assert.doesNotThrow(() => safePath(repo, "src/deep/new/file.js"));

  // End to end through the tools: nothing is read from or written to the outside folder.
  const r = new OllamaRunner();
  await assert.rejects(r.exec("read_file", { path: "file-link" }, { cwd: repo, checks: [] }), /symbolic link/);
  await assert.rejects(r.exec("write_file", { path: "link/pwned.txt", content: "x" }, { cwd: repo, checks: [] }), /symbolic link/);
  await assert.rejects(r.exec("write_file", { path: "broken", content: "x" }, { cwd: repo, checks: [] }), /broken symbolic link/);
  assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false);
  assert.equal(fs.existsSync(path.join(outside, "nope.txt")), false);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET\n");
});

function get(port, headers = {}, method = "GET", url = "/") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("board refuses foreign Host headers (DNS rebinding) and sends a locked-down page", async () => {
  const dir = tmp();
  const config = loadConfig(initProject(dir).configFile);
  const server = await serveBoard(config, createSource(config), { port: 0 });
  const { port } = server.address();
  try {
    assert.equal((await get(port, { Host: "evil.example.com" })).status, 403);
    assert.equal((await get(port, { Host: `evil.example.com:${port}` }, "GET", "/api/state")).status, 403);
    assert.equal((await get(port, { Host: "127.0.0.1" })).status, 403); // wrong port
    const ok = await get(port, { Host: `localhost:${port}` });
    assert.equal(ok.status, 200);
    assert.match(ok.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal((await get(port, { Host: `127.0.0.1:${port}` }, "GET", "/api/state")).status, 200);
    assert.equal((await get(port, { Host: `127.0.0.1:${port}` }, "POST")).status, 405);
  } finally {
    server.close();
  }
});

test("Ungrind's own tokens are not passed to agents or check commands", async () => {
  process.env.TEST_UNGRIND_NOTION = "notion-secret";
  process.env.TEST_UNGRIND_NTFY = "ntfy-secret";
  process.env.TEST_UNRELATED = "kept";
  try {
    const { config, errors } = validateConfig({
      project: "p", taskSource: { adapter: "notion", databaseId: "db", tokenEnv: "TEST_UNGRIND_NOTION" },
      verifiers: [{ name: "t", command: "true" }], gates: { notify: { ntfyTopic: "t", tokenEnv: "TEST_UNGRIND_NTFY" } },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.agent.unsetEnv, ["TEST_UNGRIND_NOTION", "TEST_UNGRIND_NTFY"]);

    const env = childEnv(config.agent.unsetEnv, { EXTRA: "1" });
    assert.equal(env.TEST_UNGRIND_NOTION, undefined);
    assert.equal(env.TEST_UNGRIND_NTFY, undefined);
    assert.equal(env.TEST_UNRELATED, "kept");
    assert.equal(env.EXTRA, "1");
    assert.equal(process.env.TEST_UNGRIND_NOTION, "notion-secret"); // our own process still has it

    const dir = tmp();
    const check = { name: "env", command: 'echo "[$TEST_UNGRIND_NOTION][$TEST_UNGRIND_NTFY][$TEST_UNRELATED]"', cwd: ".", timeoutSec: 10, pass: { exitCode: 0 } };
    assert.match((await commandCheck(check, dir, { unsetEnv: config.agent.unsetEnv })).output, /\[\]\[\]\[kept\]/);
    assert.match((await commandCheck(check, dir)).output, /\[notion-secret\]\[ntfy-secret\]\[kept\]/); // sanity: without scrubbing they leak

    const bin = path.join(dir, "fake-agent");
    fs.writeFileSync(bin, '#!/bin/sh\necho "[$TEST_UNGRIND_NOTION][$TEST_UNRELATED]"\n');
    fs.chmodSync(bin, 0o755);
    const r = await spawnAgent(bin, [], { cwd: dir, input: "", timeoutMs: 5000, unsetEnv: config.agent.unsetEnv });
    assert.equal(r.stdout.trim(), "[][kept]");
  } finally {
    delete process.env.TEST_UNGRIND_NOTION; delete process.env.TEST_UNGRIND_NTFY; delete process.env.TEST_UNRELATED;
  }
});

test("branch name rule rejects option-like and malformed patterns", () => {
  const base = { project: "p", taskSource: { adapter: "local" }, verifiers: [{ name: "t", command: "true" }] };
  const errs = (branchPattern) => validateConfig({ ...base, guardrails: { branchPattern } }).errors.join();
  for (const ok of ["loop/{slug}", "feature/ug_{slug}", "bot-{slug}.x"]) assert.equal(errs(ok), "", ok);
  for (const bad of ["-x/{slug}", "--upload-pack={slug}", "loop/../{slug}", "loop//{slug}", "loop/{slug}/", "loop {slug}", "loop/{slug};rm", "loop/$({slug})", "/{slug}", "loop/{slug}.lock", "a@{{slug}"]) {
    assert.match(errs(bad), /branchPattern/, bad);
  }
});

test("run logs are kept out of git even with `git add -A`", () => {
  const dir = tmp();
  const config = loadConfig(initProject(dir).configFile);
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"], { cwd: dir });
  writeRunLog(config.prompts.stateDir, { ts: "2026-01-01", result: "done", attempts: [{ failure: "token=abc123 printed by a test" }] });
  fs.writeFileSync(path.join(config.prompts.stateDir, "conventions.md"), "# conventions\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  assert.ok(!staged.includes(".ungrind/runs.jsonl"), staged.join());
  assert.ok(staged.includes(".ungrind/conventions.md")); // conventions can still be committed on purpose
});
