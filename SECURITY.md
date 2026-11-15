# Security notes

Ungrind runs AI coding agents and shell commands on your Mac. This page says what it protects against, what it doesn't, and what to do about the gaps. It is not a guarantee.

## What you are trusting

- **Rules files are code.** `ungrind.config.yaml` lists check commands, and Ungrind runs them with `sh -c` when a card ships. The cron `precheckCommand` does the same. Only add projects whose rules file you trust, and read a rules file you didn't write before you ship from it.
- **Agents can run commands.** By default Claude Code is allowed `Bash`, `Edit`, `Write`, `Read`, `Glob`, and `Grep` in the project folder, with `git push`, `merge`, `checkout`, `switch`, `reset`, and `branch` blocked. A `Bash` tool can still do anything your user account can, including reading files outside the project and using the network. Text inside a project (code, comments, a README, a card) can try to steer the agent. The diff guard, forbidden paths, and the branch-only workflow limit what lands in your repo; they do not stop an agent from reading or sending data elsewhere. To tighten this, narrow `agent.allowedTools` (for example to `Bash(npm test:*)`). Run unfamiliar projects in a throwaway copy or a VM.
- **The first pass and onboarding are read-only.** They run with Read, Glob, and Grep only.
- **Local models (Ollama)** get five tools scoped to the project folder: list, read, write, replace, and run the configured checks. There is no shell. Paths are resolved through symbolic links, so a link inside the project can't lead outside it.

## What Ungrind does to limit damage

- Never commits to `main`, never force pushes, never merges. Only the loop branch is pushed, and only if the configured remote exists.
- Fails a run that changes forbidden paths, files outside the card's scope, or too many files.
- Doesn't pass its own credentials (the Notion token and the ntfy token) to agents or check commands.
- Keeps run logs (`.ungrind/runs.jsonl`, which can contain command output) out of git with a `.ungrind/.gitignore`.
- The board (`ungrind board`) listens on localhost only, answers only GET requests, only for loopback host names, and sends a strict content policy.
- Branch names must use letters, numbers, `.`, `_`, `-`, and `/`.

## Data that leaves your Mac

- **Claude Code** sends prompts, project files the agent reads, and check output to Anthropic, under your Claude sign-in. Runs count against your subscription unless `ANTHROPIC_API_KEY` is set, in which case they bill that API key. The setup check tells you which.
- **Codex**, if you use it, sends the same to OpenAI.
- **ntfy** notifications send the card title, branch name, tier path, cost, and a one-line reason to the ntfy server (https://ntfy.sh unless you set `server`). On the public server the topic name is the only protection, so use a long random topic, or self-host.
- **Notion**, if you use it, talks to api.notion.com with your integration token, which is read from an environment variable and never written to disk by Ungrind.
- Local models and everything else stay on your Mac.

## Dependencies and updates

- Ungrind has **no third-party packages**: no npm dependencies and no Swift package dependencies. There is nothing in the dependency tree to audit, and `npm audit` has nothing to check.
- It does depend on **Node.js**, **git**, **Claude Code**, and optionally Ollama and Codex on your machine. Keep them updated. The setup check warns when your Node version is older than the last security release it knows about (it can be out of date, so also check https://nodejs.org/en/blog/vulnerability).
- The Mac app is signed ad hoc and is not notarized.

## Reporting a problem

Open a private security advisory on the GitHub repository, or contact the maintainer directly. Please don't post details in a public issue.
