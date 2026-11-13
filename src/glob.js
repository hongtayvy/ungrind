// Tiny glob matcher: `**`, `*`, `?`. Paths use forward slashes, relative to repo root.

export function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function globToRegExp(glob) {
  let re = "";
  const g = normalizePath(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** True if `file` matches the glob, or lives under a folder named by the pattern. */
export function matchesPattern(file, pattern) {
  const f = normalizePath(file);
  const p = normalizePath(pattern);
  if (globToRegExp(p).test(f)) return true;
  // A plain path or folder also covers everything beneath it.
  return f.startsWith(p + "/") || globToRegExp(p + "/**").test(f);
}

export const matchesAny = (file, patterns) => patterns.some((p) => matchesPattern(file, p));
