import { LocalSource } from "./local.js";
import { NotionSource } from "./notion.js";
import { validateTask, readyCandidates } from "../task.js";

/**
 * Task source interface (implemented by every adapter):
 *   listTasks()                 -> Task[]   (contract shape, see task.js)
 *   setStatus(task, status)     -> void     (status: ready | in_progress | done | blocked)
 *   attach(task, kind, text)    -> void     (kind: "notes" | "summary")
 * "Get the next ready task" is derived from listTasks() by nextReady() so every adapter
 * gets identical queue semantics.
 */
export function createSource(config, deps = {}) {
  switch (config.taskSource.adapter) {
    case "local": return new LocalSource(config);
    case "notion": return new NotionSource(config, deps);
    default: throw new Error(`Unknown task source adapter: ${config.taskSource.adapter}`);
  }
}

/**
 * Returns { task, skipped[] }. Tasks that fail contract validation are reported in `skipped`
 * and (unless dryRun) marked blocked with a reason, instead of being guessed at.
 */
export async function nextReady(source, { dryRun = false, onlyId = null, extraProblems = null } = {}) {
  const all = await source.listTasks();
  const skipped = [];
  let candidates = readyCandidates(all);
  if (onlyId) candidates = candidates.filter((t) => t.id === onlyId);
  for (const task of candidates) {
    const problems = [...validateTask(task), ...(extraProblems ? extraProblems(task) : [])];
    if (problems.length === 0) return { task, skipped, all };
    const reason = `Failed task contract: ${problems.join("; ")}`;
    skipped.push({ id: task.id, reason });
    if (!dryRun) {
      await source.attach(task, "notes", `Blocked before running. ${reason}`);
      await source.setStatus(task, "blocked");
    }
  }
  return { task: null, skipped, all };
}
