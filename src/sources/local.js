import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "../yaml.js";

/**
 * Local files adapter. One markdown file per task (also works on an Obsidian vault folder).
 *
 *   ---
 *   title: Add health endpoint
 *   status: Ready
 *   priority: 1
 *   files: [src/health.js, test/health.test.js]
 *   dependencies: [other-task-id]   # optional, by file name without .md or by `id:`
 *   size: small                      # optional
 *   type: feature                    # optional
 *   ---
 *   ## Goal
 *   ...
 *   ## Acceptance criteria
 *   - ...
 *
 * The engine appends `## Notes` and `## Summary` sections to the body.
 */
export class LocalSource {
  constructor(config) {
    this.dir = path.resolve(config.repo, config.taskSource.path);
    this.statusNames = config.taskSource.statuses;
    this.toInternal = Object.fromEntries(Object.entries(this.statusNames).map(([k, v]) => [String(v).toLowerCase(), k]));
  }

  files() {
    if (!fs.existsSync(this.dir)) throw new Error(`Task folder not found: ${this.dir}`);
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue; // skips .obsidian etc.
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) out.push(p);
      }
    };
    walk(this.dir);
    return out.sort();
  }

  async listTasks() {
    const tasks = [];
    for (const file of this.files()) {
      const { data, body } = parseFrontMatter(fs.readFileSync(file, "utf8"));
      if (!data.status && !data.title) continue; // not a task note
      tasks.push(this.parse(file, data, body));
    }
    return tasks;
  }

  parse(file, data, body) {
    const sections = splitSections(body);
    const list = (v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));
    const rawStatus = String(data.status ?? "");
    return {
      id: String(data.id ?? path.basename(file, ".md")),
      title: data.title ?? sections.title ?? "",
      goal: (data.goal ?? sections.goal ?? "").trim(),
      criteria: data.criteria ? list(data.criteria) : bullets(sections["acceptance criteria"] ?? sections.criteria ?? ""),
      files: list(data.files),
      status: this.toInternal[rawStatus.toLowerCase()] ?? `unknown:${rawStatus}`,
      priority: typeof data.priority === "number" ? data.priority : Number(data.priority ?? NaN),
      dependencies: list(data.dependencies),
      size: data.size ?? null,
      type: data.type ?? null,
      approved: data.approved === true,
      notes: (sections.notes ?? "").trim(),
      summary: (sections.summary ?? "").trim(),
      _file: file,
    };
  }

  async setStatus(task, status) {
    const name = this.statusNames[status];
    const text = fs.readFileSync(task._file, "utf8");
    const next = /^status:.*$/m.test(text.split(/\r?\n---/)[0])
      ? text.replace(/^status:.*$/m, `status: ${name}`)
      : text.replace(/^---\r?\n/, `---\nstatus: ${name}\n`);
    fs.writeFileSync(task._file, next);
    task.status = status;
  }

  /** kind: "notes" | "summary". Appends under a `## Notes` / `## Summary` heading. */
  async attach(task, kind, text) {
    const heading = kind === "summary" ? "Summary" : "Notes";
    let body = fs.readFileSync(task._file, "utf8");
    const stamp = new Date().toISOString();
    const entry = `\n_${stamp}_\n\n${text.trim()}\n`;
    const re = new RegExp(`^## ${heading}\\s*$`, "m");
    body = re.test(body) ? appendToSection(body, heading, entry) : `${body.replace(/\s+$/, "")}\n\n## ${heading}\n${entry}`;
    fs.writeFileSync(task._file, body);
  }
}

function appendToSection(text, heading, entry) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## ${heading}\\s*$`).test(l));
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n");
  return `${before}\n${entry}${after ? `\n${after}` : ""}`;
}

function splitSections(body) {
  const out = {};
  let key = null;
  const buf = {};
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      key = h[2].trim().toLowerCase();
      if (h[1] === "#" && !out.title) out.title = h[2].trim();
      buf[key] = [];
    } else if (key) buf[key].push(line);
  }
  for (const [k, v] of Object.entries(buf)) out[k] = v.join("\n").trim();
  return out;
}

function bullets(text) {
  return text
    .split("\n")
    .map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.*)$/)?.[1]?.trim())
    .filter(Boolean);
}
