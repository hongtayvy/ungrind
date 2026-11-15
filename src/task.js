import { STATUSES } from "./config.js";

/**
 * The task contract. Every task source adapter maps onto this shape:
 * { id, title, goal, criteria[], files[], status, priority, dependencies[], size?, type?, notes, summary }
 * `status` is always one of STATUSES (adapters translate to and from their own names).
 * `priority` is a number; LOWER runs first (1 = most urgent).
 */
export function validateTask(task) {
  const problems = [];
  if (!task.title || !String(task.title).trim()) problems.push("missing title");
  if (!task.goal || !String(task.goal).trim()) problems.push("missing goal");
  if (!Array.isArray(task.criteria) || task.criteria.filter((c) => c.trim()).length < 1) {
    problems.push("needs at least one acceptance criterion");
  }
  if (!Array.isArray(task.files) || task.files.length === 0) {
    problems.push("missing files in scope (the diff guard needs at least one path)");
  } else {
    for (const f of task.files) {
      if (f.startsWith("/") || f.split("/").includes("..")) problems.push(`files in scope must be repo-relative: ${f}`);
      if (["*", "**", "**/*", ".", "./"].includes(f.trim())) problems.push(`files in scope is too broad: "${f}"`);
    }
  }
  if (!STATUSES.includes(task.status)) problems.push(`unknown status "${task.status}"`);
  if (typeof task.priority !== "number" || Number.isNaN(task.priority)) problems.push("missing numeric priority");
  return problems;
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "task";
}

/** Render the task card as markdown for prompt slots. */
export function renderTaskCard(task) {
  return [
    `# ${task.title}`,
    "",
    "## Goal",
    task.goal,
    "",
    "## Acceptance criteria",
    ...task.criteria.map((c) => `- ${c}`),
  ].join("\n");
}

/** Pure queue selection: ready tasks whose dependencies are all done, best priority first. */
export function readyCandidates(tasks) {
  const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  return tasks
    .filter((t) => t.status === "ready" && !t.archived && t.dependencies.every((d) => doneIds.has(d)))
    .sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
}

function rank(t) {
  return Number.isFinite(t.priority) ? t.priority : Number.MAX_SAFE_INTEGER;
}
