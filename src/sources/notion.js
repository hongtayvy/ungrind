const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

const DEFAULT_PROPS = {
  title: "Name",
  goal: "Goal",
  criteria: "Acceptance criteria",
  files: "Files in scope",
  status: "Status",
  priority: "Priority",
  dependencies: "Dependencies",
  size: "Size",
  type: "Type",
  approved: "Approved",
};

/**
 * Notion adapter: one database row per task, one property per contract field.
 * Config (taskSource):
 *   adapter: notion
 *   databaseId: <id>
 *   tokenEnv: NOTION_TOKEN            # env var holding the integration token
 *   properties: { files: "Scope" }    # override any property name
 *   statuses: { ready: "Ready", ... } # status name mapping
 * Notes and summaries are appended to the page body as tagged paragraphs.
 * `deps.fetch` lets tests inject a fake fetch.
 */
export class NotionSource {
  constructor(config, deps = {}) {
    const ts = config.taskSource;
    this.databaseId = ts.databaseId;
    this.props = { ...DEFAULT_PROPS, ...(ts.properties ?? {}) };
    this.statusNames = ts.statuses;
    this.toInternal = Object.fromEntries(Object.entries(ts.statuses).map(([k, v]) => [String(v).toLowerCase(), k]));
    this.token = deps.token ?? process.env[ts.tokenEnv];
    this.fetch = deps.fetch ?? globalThis.fetch;
  }

  async call(method, path, body) {
    if (!this.token) throw new Error("Notion token missing: set the env var named by taskSource.tokenEnv (default NOTION_TOKEN)");
    const res = await this.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Notion ${method} ${path} failed: ${res.status} ${json.message ?? ""}`);
    return json;
  }

  async listTasks() {
    const pages = [];
    let cursor;
    do {
      const r = await this.call("POST", `/databases/${this.databaseId}/query`, { page_size: 100, start_cursor: cursor });
      pages.push(...r.results);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return pages.map((p) => this.parse(p));
  }

  parse(page) {
    const P = page.properties;
    const get = (k) => P[this.props[k]];
    const statusProp = get("status");
    const rawStatus = statusProp?.status?.name ?? statusProp?.select?.name ?? "";
    const dependencies = (get("dependencies")?.relation ?? []).map((r) => r.id);
    const textDeps = dependencies.length ? [] : lines(text(get("dependencies")), /[,\n]/);
    return {
      id: page.id,
      title: text(get("title")),
      goal: text(get("goal")).trim(),
      criteria: lines(text(get("criteria")), /\n/).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")),
      files: lines(text(get("files")), /[\n,]/),
      status: this.toInternal[rawStatus.toLowerCase()] ?? `unknown:${rawStatus}`,
      priority: get("priority")?.number ?? Number(text(get("priority")) || NaN),
      dependencies: [...dependencies, ...textDeps],
      size: get("size")?.select?.name ?? (text(get("size")) || null),
      type: get("type")?.select?.name ?? (text(get("type")) || null),
      approved: get("approved")?.checkbox === true,
      notes: "",
      summary: "",
      _statusKind: statusProp?.status ? "status" : "select",
    };
  }

  async setStatus(task, status) {
    const name = this.statusNames[status];
    const value = task._statusKind === "status" ? { status: { name } } : { select: { name } };
    await this.call("PATCH", `/pages/${task.id}`, { properties: { [this.props.status]: value } });
    task.status = status;
  }

  async attach(task, kind, body) {
    const tag = `[ungrind:${kind}] `;
    const chunks = [];
    const full = `${tag}${new Date().toISOString()}\n${body.trim()}`;
    for (let i = 0; i < full.length; i += 1900) chunks.push(full.slice(i, i + 1900));
    await this.call("PATCH", `/blocks/${task.id}/children`, {
      children: chunks.map((c) => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: c } }] },
      })),
    });
  }

  /** Read back previously attached notes so retries across runs do not repeat mistakes. */
  async loadNotes(task) {
    const out = [];
    let cursor;
    do {
      const r = await this.call("GET", `/blocks/${task.id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      for (const b of r.results) {
        const t = (b.paragraph?.rich_text ?? []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");
        if (t.startsWith("[ungrind:notes]")) out.push(t.replace("[ungrind:notes] ", ""));
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return out.join("\n\n");
  }
}

function text(prop) {
  if (!prop) return "";
  const arr = prop.title ?? prop.rich_text;
  if (arr) return arr.map((x) => x.plain_text ?? x.text?.content ?? "").join("");
  if (prop.select) return prop.select.name ?? "";
  if (prop.number != null) return String(prop.number);
  return "";
}

const lines = (s, sep) => s.split(sep).map((x) => x.trim()).filter(Boolean);
