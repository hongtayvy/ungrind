// Minimal YAML subset parser (zero dependencies).
// Supports: nested maps, block lists, lists of maps, flow [a, b] / {a: b},
// quoted strings, comments, `|` and `>` block scalars, true/false/null/numbers.
// Not supported: anchors, tags, multi-document streams, complex keys.

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q && line[i - 1] !== "\\") q = null;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitFlow(s) {
  const parts = [];
  let depth = 0, q = null, cur = "";
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}

export function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith("[") && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map(parseScalar);
  if (s.startsWith("{") && s.endsWith("}")) {
    const o = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const m = part.match(/^("[^"]*"|'[^']*'|[^:]+?):\s*(.*)$/);
      if (m) o[String(parseScalar(m[1]))] = parseScalar(m[2]);
    }
    return o;
  }
  return s;
}

const KEY_RE = /^("[^"]*"|'[^']*'|[^\s:][^:]*?):(?:\s+(.*))?$/;
const isListItem = (t) => t === "-" || t.startsWith("- ");

export function parseYaml(text) {
  const lines = [];
  for (const raw of text.replace(/\t/g, "  ").split(/\r?\n/)) {
    const stripped = stripComment(raw).replace(/\s+$/, "");
    if (!stripped.trim()) continue;
    lines.push({ indent: stripped.match(/^ */)[0].length, text: stripped.trim(), raw });
  }
  if (!lines.length) return {};
  let i = 0;

  function parseBlock() {
    return isListItem(lines[i].text) ? parseList(lines[i].indent) : parseMap(lines[i].indent);
  }

  function blockScalar(indent, style) {
    const out = [];
    while (i < lines.length && lines[i].indent > indent) {
      out.push(lines[i].raw.slice(Math.min(lines[i].indent, lines[i].raw.length)).trimEnd());
      i++;
    }
    return (style.startsWith(">") ? out.join(" ") : out.join("\n")).trim();
  }

  function parseList(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isListItem(lines[i].text)) {
      const rest = lines[i].text.slice(1).trim();
      if (!rest) {
        i++;
        arr.push(i < lines.length && lines[i].indent > indent ? parseBlock() : null);
      } else if (KEY_RE.test(rest) && !/^["'[{]/.test(rest)) {
        lines[i] = { ...lines[i], indent: indent + 2, text: rest };
        arr.push(parseMap(indent + 2));
      } else {
        arr.push(parseScalar(rest));
        i++;
      }
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isListItem(lines[i].text)) {
      const m = lines[i].text.match(KEY_RE);
      if (!m) throw new Error(`YAML parse error near: "${lines[i].text}"`);
      const key = String(parseScalar(m[1]));
      const val = (m[2] ?? "").trim();
      i++;
      if (val === "|" || val === ">" || val === "|-" || val === ">-") {
        obj[key] = blockScalar(indent, val);
      } else if (val === "") {
        if (i < lines.length && lines[i].indent > indent) obj[key] = parseBlock();
        else if (i < lines.length && lines[i].indent === indent && isListItem(lines[i].text)) obj[key] = parseList(indent);
        else obj[key] = null;
      } else {
        obj[key] = parseScalar(val);
      }
    }
    return obj;
  }

  const result = parseBlock();
  if (i < lines.length) throw new Error(`YAML parse error near: "${lines[i].text}"`);
  return result;
}

/** Split `---\nfront matter\n---\nbody` into { data, body }. */
export function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return { data: {}, body: text };
  return { data: parseYaml(m[1]), body: m[2] ?? "" };
}
