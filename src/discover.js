import { fill, readConventions } from "./prompts.js";
import { runStrongest } from "./onboard.js";
import { saveCard } from "./app.js";
import { validateTask, slugify } from "./task.js";

/**
 * First pass over a folder: the strongest tier reads the repo (read-only) and describes it as
 * feature cards. Features that already exist become Shipped cards; unfinished work it finds
 * evidence for becomes draft cards. Drafts never run until a human marks them ready.
 */

/** Pull the cards out of the model's reply. Returns { cards, rejected[] } with contract-checked cards only. */
export function parseDiscovery(output) {
  const fenced = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const candidates = [...fenced.reverse(), output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)];
  let raw = null;
  for (const c of candidates) {
    try { const j = JSON.parse(c); raw = Array.isArray(j) ? j : j.cards; if (Array.isArray(raw)) break; } catch { /* try the next candidate */ }
  }
  if (!Array.isArray(raw)) throw new Error("The first pass did not return a list of cards.");
  const cards = [], rejected = [];
  const strs = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  for (const c of raw) {
    const card = {
      state: c?.state === "shipped" ? "shipped" : "proposed",
      title: String(c?.title ?? "").trim(), goal: String(c?.goal ?? "").trim(),
      criteria: strs(c?.criteria), files: strs(c?.files).map((f) => f.replace(/^\.\//, "")),
      size: ["small", "medium", "large"].includes(c?.size) ? c.size : null,
      evidence: c?.evidence ? String(c.evidence).trim() : null,
    };
    const problems = validateTask({ ...card, status: "ready", priority: 1 });
    if (problems.length) rejected.push({ title: card.title || "(untitled)", reason: problems.join("; ") });
    else cards.push(card);
  }
  return { cards, rejected };
}

export async function discover({ config, source, runners, templates, max = 12, log = () => {} }) {
  if (config.taskSource.adapter !== "local") throw new Error("The first pass only works with the local files task source.");
  const existing = await source.listTasks();
  const taken = new Set(existing.flatMap((t) => [slugify(t.title ?? ""), String(t.id)]));
  const prompt = fill(templates.discover, {
    max: String(max),
    existing: existing.length ? existing.map((t) => `- ${t.title}`).join("\n") : "(none yet)",
    conventions: readConventions(config.prompts) || "(no conventions file yet)",
  });
  log(`[ungrind] first pass: reading ${config.repo} (read-only)...`);
  const res = await runStrongest({ config, runners, prompt });
  if (res.exitCode !== 0) throw new Error(`The first pass run failed (exit ${res.exitCode}):\n${res.output.slice(-1500)}`);
  const { cards, rejected } = parseDiscovery(res.output);

  let priority = Math.max(0, ...existing.map((t) => (Number.isFinite(t.priority) ? t.priority : 0)));
  const created = [], skipped = [];
  for (const c of cards.slice(0, max)) {
    if (taken.has(slugify(c.title))) { skipped.push({ title: c.title, reason: "a card with this title already exists" }); continue; }
    taken.add(slugify(c.title));
    const shipped = c.state === "shipped";
    const saved = saveCard(config, {
      title: c.title, goal: c.evidence && !shipped ? `${c.goal}\n\nEvidence: ${c.evidence}` : c.goal, criteria: c.criteria, files: c.files,
      status: shipped ? "done" : "ready", draft: !shipped, size: shipped ? null : c.size, priority: ++priority,
    });
    created.push({ id: saved.id, title: c.title, state: c.state });
  }
  for (const c of cards.slice(max)) skipped.push({ title: c.title, reason: `over the limit of ${max} cards` });
  log(`[ungrind] first pass: ${created.length} card(s) written`);
  return { created, skipped: [...skipped, ...rejected], costUsd: res.usage?.costUsd ?? 0, durationMs: res.durationMs ?? 0 };
}
