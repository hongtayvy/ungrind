import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runOnce } from "./engine.js";
import { readRunLog, writeRunLog } from "./runlog.js";

/**
 * Cron wrapper: one scheduled invocation = lock, usage pre-check, then up to
 * cron.maxTasksPerRun tasks in sequence (never in parallel).
 *
 * Usage pre-check, so runs skip when the subscription is tight:
 *   - budgets from the run log: dailyUsd, weeklyUsd (rolling 7 days), maxRunsPerDay
 *     (with `claude -p` on a subscription, cost is Claude Code's notional estimate; still a good usage proxy)
 *   - precheckCommand: any shell command; non-zero exit means "skip this run"
 *     (plug in your own usage script here)
 */

const DAY = 24 * 3600 * 1000;
const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function usageSoFar(records, now = new Date()) {
  let todayUsd = 0, weekUsd = 0, runsToday = 0;
  for (const r of records) {
    if (r.dryRun || !r.ts) continue;
    const t = new Date(r.ts);
    const cost = r.totalCostUsd ?? 0;
    if (now - t < 7 * DAY) weekUsd += cost;
    if (sameLocalDay(t, now)) {
      todayUsd += cost;
      if (r.attempts?.length) runsToday++;
    }
  }
  return { todayUsd, weekUsd, runsToday };
}

export function precheck(config, { now = new Date(), exec = defaultExec } = {}) {
  const c = config.cron;
  const u = usageSoFar(readRunLog(config.prompts.stateDir), now);
  if (c.dailyUsd != null && u.todayUsd >= c.dailyUsd) return { ok: false, reason: `daily budget reached ($${u.todayUsd.toFixed(2)} of $${c.dailyUsd})`, usage: u };
  if (c.weeklyUsd != null && u.weekUsd >= c.weeklyUsd) return { ok: false, reason: `weekly budget reached ($${u.weekUsd.toFixed(2)} of $${c.weeklyUsd})`, usage: u };
  if (c.maxRunsPerDay != null && u.runsToday >= c.maxRunsPerDay) return { ok: false, reason: `max runs per day reached (${u.runsToday})`, usage: u };
  if (c.precheckCommand) {
    const r = exec(c.precheckCommand, config.repo);
    if (r.status !== 0) return { ok: false, reason: `usage pre-check said no (exit ${r.status}): ${r.output.trim().split("\n").pop() ?? ""}`.trim(), usage: u };
  }
  return { ok: true, reason: null, usage: u };
}

function defaultExec(command, cwd) {
  const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout: 60_000 });
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Returns a release function, or null if another live run holds the lock. */
export function acquireLock(stateDir, staleMin) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "cron.lock");
  if (fs.existsSync(file)) {
    try {
      const { pid, ts } = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pid !== process.pid && alive(pid) && Date.now() - new Date(ts) < staleMin * 60_000) return null;
    } catch { /* unreadable lock: treat as stale */ }
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  return () => { try { fs.unlinkSync(file); } catch {} };
}

export async function cronRun({ config, source, runner = null, runners = null, templates, notify = null, log = console.log, now = () => new Date(), exec }) {
  const release = acquireLock(config.prompts.stateDir, config.cron.lockStaleMin);
  if (!release) { log("[ungrind] another run holds the lock, exiting"); return [{ result: "locked" }]; }
  const results = [];
  try {
    for (let i = 0; i < config.cron.maxTasksPerRun; i++) {
      const pc = precheck(config, { now: now(), exec });
      if (!pc.ok) {
        const record = { ts: now().toISOString(), project: config.project, dryRun: false, task: null, attempts: [], result: "skipped-usage", reason: pc.reason, totalCostUsd: 0 };
        writeRunLog(config.prompts.stateDir, record);
        log(`[ungrind] skipping: ${pc.reason}`);
        if (notify) await notify("skipped", record);
        results.push(record);
        break;
      }
      let r;
      try {
        r = await runOnce({ config, source, runner, runners, templates, log, notify });
      } catch (e) {
        r = { ts: now().toISOString(), project: config.project, dryRun: false, task: null, attempts: [], result: "error", reason: e.message, totalCostUsd: 0 };
        writeRunLog(config.prompts.stateDir, r);
        log(`[ungrind] run failed: ${e.message}`);
        if (notify) await notify("blocked", r);
        results.push(r);
        break;
      }
      results.push(r);
      if (r.result === "nothing-ready") break;
    }
  } finally {
    release();
  }
  return results;
}

/** A crontab line with absolute paths, since cron runs with a minimal environment. */
export function crontabLine(config, { schedule = "*/30 * * * *", node = process.execPath, bin, pathEnv = process.env.PATH } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const logFile = path.join(config.prompts.stateDir, "cron.log");
  return `${schedule} cd ${q(config.repo)} && PATH=${q(pathEnv)} ${q(node)} ${q(bin)} cron --config ${q(config.file)} >> ${q(logFile)} 2>&1`;
}
