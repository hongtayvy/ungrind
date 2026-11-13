import { execFileSync } from "node:child_process";

export function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
}

/** Pathspec excludes so engine-written files (task notes, state dir) never count as agent work. */
export const excludeSpecs = (paths) => paths.map((p) => `:(exclude)${p}`);

export const currentBranch = (repo) => git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
export const hasRemote = (repo, remote) => git(repo, ["remote"]).split("\n").includes(remote);

/**
 * Files changed vs HEAD (tracked, incl. deletions) plus untracked files, minus excluded paths.
 * Paths are relative to `repo`, which may be a subfolder of the git work tree.
 */
export function changedFiles(repo, excludes = []) {
  const spec = ["--", ".", ...excludeSpecs(excludes)];
  const tracked = git(repo, ["-c", "core.quotepath=off", "diff", "--name-only", "--relative", "HEAD", ...spec]);
  const untracked = git(repo, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", ...spec]);
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort();
}

export function commitAll(repo, message, excludes = []) {
  git(repo, ["add", "-A", "--", ".", ...excludeSpecs(excludes)]);
  const staged = git(repo, ["diff", "--cached", "--name-only"]);
  if (!staged) return false;
  git(repo, ["-c", "user.name=ungrind", "-c", "user.email=ungrind@localhost", "commit", "-m", message, "--no-verify"]);
  return true;
}
