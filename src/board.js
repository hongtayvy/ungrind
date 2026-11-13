import fs from "node:fs";
import http from "node:http";
import { readRunLog } from "./runlog.js";
import { validateTask, readyCandidates } from "./task.js";

/**
 * Read-only board over the task source and the run log. Never writes anything.
 *   ungrind board                 serve on http://127.0.0.1:4477 (localhost only)
 *   ungrind board --out b.html    write a static snapshot
 */

const COLUMNS = [["ready", "Ready"], ["in_progress", "In progress"], ["blocked", "Blocked"], ["done", "Done"]];

export async function buildState(config, source, { maxRuns = 30 } = {}) {
  const tasks = await source.listTasks();
  const runnable = new Set(readyCandidates(tasks).map((t) => t.id));
  const runs = readRunLog(config.prompts.stateDir).filter((r) => r.result !== "nothing-ready").slice(-maxRuns).reverse();
  const card = (t) => ({
    id: t.id, title: t.title, priority: t.priority, size: t.size, type: t.type, files: t.files, dependencies: t.dependencies,
    problems: validateTask(t), waiting: t.status === "ready" && !runnable.has(t.id),
    summary: (t.summary || "").split("\n").filter(Boolean).slice(-4).join("\n"),
  });
  const columns = Object.fromEntries(COLUMNS.map(([k]) => [k, tasks.filter((t) => t.status === k).sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9)).map(card)]));
  const unknown = tasks.filter((t) => !COLUMNS.some(([k]) => k === t.status)).map(card);
  return {
    project: config.project, generated: new Date().toISOString(), columns, unknown,
    runs: runs.map((r) => ({
      ts: r.ts, task: r.task?.title ?? null, result: r.result, reason: r.reason, branch: r.branch, dryRun: r.dryRun,
      path: (r.attempts ?? []).map((a) => `${a.tier}${a.passed ? "✓" : "✗"}`).join(" → "),
      agents: [...new Set((r.attempts ?? []).map((a) => a.agent ?? "claude-code"))].join(", "),
      costUsd: r.totalCostUsd ?? 0, durationMs: r.durationMs ?? 0,
    })),
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function renderCard(c) {
  const meta = [`p${c.priority}`, c.size, c.type].filter(Boolean).map((m) => `<span class="tag">${esc(m)}</span>`).join("");
  const flags = [
    c.problems.length ? `<div class="warn">Fails contract: ${esc(c.problems.join("; "))}</div>` : "",
    c.waiting ? `<div class="muted">Waiting on: ${esc(c.dependencies.join(", "))}</div>` : "",
  ].join("");
  return `<article class="card"><h3>${esc(c.title || c.id)}</h3><div class="meta">${meta}<code>${esc(c.id)}</code></div>
<div class="files">${c.files.map((f) => `<code>${esc(f)}</code>`).join(" ")}</div>${flags}
${c.summary ? `<pre class="summary">${esc(c.summary)}</pre>` : ""}</article>`;
}

export function renderHtml(state, { refreshSec = 0 } = {}) {
  const cols = COLUMNS.map(([k, label]) => `<section class="col col-${k}"><h2>${label} <span class="count">${state.columns[k].length}</span></h2>${state.columns[k].map(renderCard).join("") || '<p class="muted">Nothing here</p>'}</section>`).join("");
  const unknown = state.unknown.length ? `<section class="col"><h2>Unknown status <span class="count">${state.unknown.length}</span></h2>${state.unknown.map(renderCard).join("")}</section>` : "";
  const rows = state.runs.map((r) => `<tr class="r-${esc(r.result)}"><td>${esc(r.ts.replace("T", " ").slice(0, 16))}</td><td>${esc(r.task ?? "-")}</td><td><b>${esc(r.result)}</b>${r.dryRun ? " (dry)" : ""}${r.reason ? `<div class="muted">${esc(r.reason.slice(0, 160))}</div>` : ""}</td><td>${esc(r.path)}</td><td>${esc(r.agents)}</td><td class="num">$${r.costUsd.toFixed(3)}</td><td class="num">${Math.round(r.durationMs / 1000)}s</td><td><code>${esc(r.branch ?? "")}</code></td></tr>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ""}<title>${esc(state.project)} · Ungrind board</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--warn:#a33;--ok:#2a7a3a}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#ececea;--muted:#9a9a94;--card:#242423;--line:#383836;--warn:#e77;--ok:#6c6}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:16px 24px;border-bottom:1px solid var(--line)}h1{margin:0;font-size:18px}
.muted{color:var(--muted);font-size:12px}.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;padding:16px 24px}
.col h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}.count{font-weight:400}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:10px}
.card h3{font-size:14px;margin:0 0 4px}.meta,.files{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:4px}
.tag{font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 5px}code{font-size:11px;color:var(--muted)}
.warn{color:var(--warn);font-size:12px}.summary{white-space:pre-wrap;font-size:12px;margin:6px 0 0;color:var(--muted)}
.runs{padding:0 24px 32px;overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums}
.r-done b{color:var(--ok)}.r-blocked b,.r-error b{color:var(--warn)}
</style></head><body>
<header><h1>${esc(state.project)}</h1><div class="muted">Read-only board · generated ${esc(state.generated)}</div></header>
<main class="board">${cols}${unknown}</main>
<section class="runs"><h2 class="muted">Recent runs</h2><table><thead><tr><th>When</th><th>Task</th><th>Result</th><th>Tiers</th><th>Agents</th><th class="num">Cost</th><th class="num">Time</th><th>Branch</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8" class="muted">No runs yet</td></tr>'}</tbody></table></section>
</body></html>`;
}

export async function writeBoard(config, source, file) {
  fs.writeFileSync(file, renderHtml(await buildState(config, source)));
  return file;
}

/** Localhost-only, GET-only server. Every request re-reads tasks and the run log. */
export function serveBoard(config, source, { port = 4477, host = "127.0.0.1", refreshSec = 15 } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }).end("read-only"); return; }
    try {
      const state = await buildState(config, source);
      if (req.url === "/api/state") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state)); return; }
      if (req.url === "/" || req.url.startsWith("/?")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderHtml(state, { refreshSec })); return; }
      res.writeHead(404).end("not found");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end(`board error: ${e.message}`);
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
