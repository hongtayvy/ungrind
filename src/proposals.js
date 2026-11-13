import fs from "node:fs";
import path from "node:path";
import { readRunLog } from "./runlog.js";
import { fill, readConventions } from "./prompts.js";
import { parseFrontMatter } from "./yaml.js";
import { runStrongest } from "./onboard.js";

/**
 * Improvement proposals (layer 3). The engine gathers failure evidence from the run log
 * (deterministically, so the evidence is real), the strongest tier drafts one addition to the
 * conventions file, and nothing changes until a human runs `ungrind accept <id>`.
 * Proposals live in <stateDir>/proposals/<id>.md with status: pending | accepted | rejected.
 */

const dirOf = (config) => path.join(config.prompts.stateDir, "proposals");

/** Classify an attempt's failure text into a coarse category so repeats group together. */
export function categorize(failure) {
  const f = failure ?? "";
  let m;
  if ((m = f.match(/^Check "([^"]+)" failed/))) {
    if (m[1] !== "diff-guard") return `check failed: ${m[1]}`;
    if (/Forbidden paths/.test(f)) return "diff guard: forbidden path";
    if (/outside the task's scope/.test(f)) return "diff guard: out of scope";
    return "diff guard: too many files";
  }
  if (/^Cross-vendor review/.test(f)) return "review rejected the change";
  if (/^Agent reported it could not proceed/.test(f)) return "agent said blocked";
  if (/^The agent made no file changes/.test(f)) return "no changes made";
  if (/^Agent run failed/.test(f)) return /timed out/.test(f.split("\n")[0]) ? "agent timed out" : "agent run failed";
  return "other";
}

export function gatherEvidence(records, { since = null, maxExamples = 3 } = {}) {
  const groups = new Map();
  let runs = 0, failedAttempts = 0;
  for (const r of records) {
    if (r.dryRun || !r.attempts?.length || (since && r.ts <= since)) continue;
    runs++;
    for (const a of r.attempts) {
      if (a.passed || !a.failure) continue;
      failedAttempts++;
      const cat = categorize(a.failure);
      const g = groups.get(cat) ?? { category: cat, count: 0, tiers: {}, examples: [] };
      g.count++;
      g.tiers[a.tier] = (g.tiers[a.tier] ?? 0) + 1;
      if (g.examples.length < maxExamples) g.examples.push({ ts: r.ts, task: r.task?.title, tier: a.tier, agent: a.agent ?? "claude-code", excerpt: a.failure.slice(0, 700) });
      groups.set(cat, g);
    }
  }
  return { runs, failedAttempts, groups: [...groups.values()].sort((a, b) => b.count - a.count) };
}

export function formatEvidence(ev) {
  const out = [`${ev.failedAttempts} failed attempt(s) across ${ev.runs} run(s).`];
  for (const g of ev.groups) {
    out.push("", `### ${g.category}: ${g.count} time(s) (${Object.entries(g.tiers).map(([t, n]) => `${t} ×${n}`).join(", ")})`);
    for (const e of g.examples) out.push(`- ${e.ts} · ${e.task} · ${e.tier}/${e.agent}`, "```", e.excerpt, "```");
  }
  return out.join("\n");
}

export function listProposals(config) {
  const dir = dirOf(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const { data, body } = parseFrontMatter(text);
    const problem = body.match(/## Problem\s*\n+([^\n]+)/)?.[1] ?? "";
    return { id: f.replace(/\.md$/, ""), file: path.join(dir, f), status: data.status, created: data.created, problem, text };
  });
}

export async function propose({ config, runners, templates, minFailures = 3, log = console.log, now = new Date() }) {
  const previous = listProposals(config).map((p) => p.created).filter(Boolean).sort().at(-1) ?? null;
  const ev = gatherEvidence(readRunLog(config.prompts.stateDir), { since: previous });
  if (ev.failedAttempts < minFailures) {
    log(`[ungrind] not enough new evidence: ${ev.failedAttempts} failed attempt(s) since ${previous ?? "the start"} (need ${minFailures}). Nothing proposed.`);
    return null;
  }
  const evidence = formatEvidence(ev);
  const prompt = fill(templates.propose, {
    evidence,
    conventions: readConventions(config.prompts) || "(no conventions file yet)",
    checks: config.verifiers.map((v) => `- ${v.name}: \`${v.command}\``).join("\n"),
  });
  log(`[ungrind] drafting a proposal from ${ev.failedAttempts} failed attempt(s)...`);
  const res = await runStrongest({ config, runners, prompt });
  if (res.exitCode !== 0 || !/## Proposed addition to conventions/.test(res.output)) {
    throw new Error(`Proposal run failed or returned the wrong format (exit ${res.exitCode}):\n${res.output.slice(-1500)}`);
  }
  const id = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const file = path.join(dirOf(config), `${id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = `---\nstatus: pending\ncreated: "${now.toISOString()}"\npromptVersion: "${templates.version}"\nfailedAttempts: ${ev.failedAttempts}\nevidenceSince: ${previous ? `"${previous}"` : "null"}\n---\n`;
  fs.writeFileSync(file, `${fm}${res.output.trim()}\n\n## Evidence (from the run log, written by the engine)\n${evidence}\n`);
  log(`[ungrind] proposal ${id} written to ${file}. Review it, then \`ungrind accept ${id}\` or \`ungrind reject ${id}\`.`);
  return { id, file };
}

/** Pull the fenced block under "## Proposed addition to conventions". */
export function extractAddition(text) {
  const section = text.split(/^## Proposed addition to conventions\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const fenced = section.match(/```[a-z]*\n([\s\S]*?)\n```/);
  return (fenced ? fenced[1] : section).trim();
}

function setStatus(file, status, extra = {}) {
  let text = fs.readFileSync(file, "utf8").replace(/^status: .*$/m, `status: ${status}`);
  for (const [k, v] of Object.entries(extra)) text = text.replace(/^---\n/, `---\n${k}: "${v}"\n`);
  fs.writeFileSync(file, text);
}

function find(config, id) {
  const p = listProposals(config).find((x) => x.id === id);
  if (!p) throw new Error(`No proposal ${id} in ${dirOf(config)}`);
  if (p.status !== "pending") throw new Error(`Proposal ${id} is already ${p.status}`);
  return p;
}

/** Human approval: append the proposed text to the conventions file. */
export function accept({ config, id, log = console.log, now = new Date() }) {
  const p = find(config, id);
  const addition = extractAddition(p.text);
  if (!addition || addition === "(none)") throw new Error(`Proposal ${id} has no conventions addition; reject it and act on its note instead.`);
  const conv = config.prompts.conventions;
  if (!fs.existsSync(conv)) throw new Error("No approved conventions file yet. Run `ungrind onboard` and `ungrind approve` first.");
  fs.copyFileSync(conv, `${conv}.${now.getTime()}.bak`);
  fs.appendFileSync(conv, `\n\n## Learned from runs (proposal ${id}, ${now.toISOString().slice(0, 10)})\n${addition}\n`);
  setStatus(p.file, "accepted", { decided: now.toISOString() });
  fs.appendFileSync(path.join(config.prompts.stateDir, "approvals.jsonl"), `${JSON.stringify({ ts: now.toISOString(), file: "conventions.md", proposal: id })}\n`);
  log(`[ungrind] accepted ${id}: appended to ${conv}`);
}

export function reject({ config, id, log = console.log, now = new Date() }) {
  const p = find(config, id);
  setStatus(p.file, "rejected", { decided: now.toISOString() });
  log(`[ungrind] rejected ${id}`);
}
