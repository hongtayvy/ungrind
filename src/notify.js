/**
 * ntfy notifications. Config (gates.notify):
 *   ntfyTopic: my-topic                  # topic on `server`
 *   server: https://ntfy.sh              # or your self-hosted ntfy
 *   tokenEnv: NTFY_TOKEN                 # optional: env var with an access token
 *   on: [done, blocked, skipped, ceiling]
 * A failed notification is logged and never fails the run.
 */

const META = {
  done: { tags: "white_check_mark", priority: "default" },
  blocked: { tags: "no_entry", priority: "high" },
  skipped: { tags: "pause_button", priority: "low" },
  ceiling: { tags: "money_with_wings", priority: "high" },
};

/** Map a run record to a notification event, or null if it should not alert. */
export function eventFor(record) {
  if (record.dryRun) return null;
  if (record.result === "done") return "done";
  if (record.result === "skipped" || record.result === "skipped-usage") return "skipped";
  if (record.result === "blocked") return /cost ceiling/.test(record.reason ?? "") ? "ceiling" : "blocked";
  return null;
}

export function formatMessage(event, record, project) {
  const title = `[${project}] ${event}: ${record.task?.title ?? record.reason ?? "run"}`;
  const lines = [];
  if (record.branch) lines.push(`branch: ${record.branch}`);
  if (record.attempts?.length) lines.push(`attempts: ${record.attempts.length} (${[...new Set(record.attempts.map((a) => a.tier))].join(" → ")})`);
  if (record.totalCostUsd) lines.push(`cost: $${record.totalCostUsd.toFixed(2)}`);
  if (record.reason) lines.push(record.reason);
  return { title: title.slice(0, 250), body: lines.join("\n") || title };
}

export function createNotifier(config, { fetch = globalThis.fetch, log = console.log } = {}) {
  const n = config.gates.notify;
  return async function notify(event, record) {
    if (!event || !n.ntfyTopic || !n.on.includes(event)) return false;
    const { title, body } = formatMessage(event, record, config.project);
    const headers = { Title: title, Tags: META[event].tags, Priority: META[event].priority };
    const token = n.tokenEnv ? process.env[n.tokenEnv] : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${n.server.replace(/\/+$/, "")}/${encodeURIComponent(n.ntfyTopic)}`, { method: "POST", headers, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e) {
      log(`[ungrind] notification failed: ${e.message}`);
      return false;
    }
  };
}
