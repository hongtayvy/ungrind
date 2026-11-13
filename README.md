# Ungrind

Ship your side projects without the grind.

Ungrind is a project-agnostic loop engine for coding agents. It pulls one task from a task source, routes it to a model tier, runs your checks, retries and escalates on failure, and logs everything. Each repo plugs in with one config file. The model never decides whether the loop continues; the engine does.

Zero dependencies. Node 20+ and the `claude` CLI (logged in) are all you need.

## Try the demo (2 minutes)

```bash
./examples/demo/setup.sh
```

```bash
node bin/ungrind.js validate --config demo-sandbox/ungrind.config.yaml
```

```bash
node bin/ungrind.js run --config demo-sandbox/ungrind.config.yaml --dry-run --skip-conventions
```

`validate` shows two ready tasks and one card that fails the contract on purpose. `run` picks the top task, branches to `loop/add-slugify-helper`, runs Claude Code headless at the Haiku tier, runs `npm test`, and commits on the branch. Drop `--dry-run` to also update task status, write notes and summaries, and push the branch (only if a remote exists).

## Commands

| Command | What it does |
|---|---|
| `validate` | Checks the config and every task card against the contract |
| `run [--dry-run] [--task id] [--skip-conventions]` | Runs at most one task through the loop |
| `onboard` | The strongest tier reads the repo (read-only) and drafts `.ungrind/conventions.draft.md` |
| `approve` | Human approval: promotes the draft to `.ungrind/conventions.md` |
| `plan --task id` | The planner proposes a crisper card. It prints only and never edits tasks |
| `stats` | First-try pass rate per prompt version, from `.ungrind/runs.jsonl` |

On a new repo, run `onboard`, read and edit the draft, then `approve`. Real runs refuse to start until a conventions file is approved.

## One run

1. Load and validate the config.
2. Read all tasks and block any ready card that fails the contract, with a reason.
3. Pick the highest-priority ready task (lowest `priority` number) whose dependencies are done.
4. Stop at the human gate if the task type is gated (auth, payments, migration) and the task is not `approved: true`.
5. Set the task to In progress and create `loop/<slug>` from the current branch. The working tree must be clean.
6. Each attempt: the engine builds the prompt from the templates, runs the agent, then runs the diff guard and the configured checks in order.
7. On pass: commit on the branch, push the branch (never force, never merge, never main), attach the summary, set Done.
8. On fail: append the exact failure to the task notes and retry with the retry prompt. After `failuresPerTier` failures the run escalates (haiku → sonnet → opus). It stops at `maxAttempts` or the cost ceiling, commits the failed work as `wip(blocked)` on the branch, and sets Blocked.
9. Append the full trajectory to `.ungrind/runs.jsonl`: prompt version, tiers, attempts, verifier output, cost, and duration.

Ungrind does not commit the files it writes itself (the task folder and `.ungrind/`), and the diff guard does not count them.

## Layout

```
bin/ungrind.js            CLI
src/config.js             config schema, defaults, validation
src/task.js               task contract, validation, queue order
src/sources/              task source interface: local.js (markdown / Obsidian), notion.js
src/agents/claude-code.js agent runner interface + Claude Code headless adapter
src/verifiers/            command check + diff guard
src/prompts.js            versioned templates with slots, output markers
src/engine.js             the loop: routing, retry, escalation, stop, logging
src/onboard.js            onboarding draft, human approval, planner
prompts/v1/*.md           base prompt per tier, retry, planner, onboarding
examples/demo/            demo repo, config, and task cards
```

## Task cards (local files / Obsidian)

```markdown
---
title: Add slugify helper
status: Ready
priority: 1               # lower runs first
size: small               # small → haiku, medium → sonnet, large → opus
files: [src/strings.js, test/strings.test.js]
dependencies: [other-task] # optional: file name or `id:`
type: feature             # optional: gated types need `approved: true`
---
## Goal
One or two sentences.

## Acceptance criteria
- Checkable statement
```

The engine appends `## Notes` (failure output per attempt) and `## Summary` (what changed and why).

## Notion

```yaml
taskSource:
  adapter: notion
  databaseId: <database id>
  tokenEnv: NOTION_TOKEN
  statuses: { ready: Ready, in_progress: In progress, done: Done, blocked: Blocked }
  properties: { title: Name, files: "Files in scope" }  # override any default property name
```

Default property names: Name, Goal, Acceptance criteria (one per line), Files in scope (comma or newline separated), Status (status or select), Priority (number), Dependencies (relation or text), Size, Type, Approved (checkbox). Notes and summaries are appended to the page body as tagged paragraphs, and later runs read them back.

## Prompts

Templates live in `prompts/<version>/`. The prompt version in the logs is `<dir>+<hash of all templates>`, so any edit to a template creates a new version, and `stats` compares pass rates before and after. The agent never edits its own prompts. Changes go through a human, like any other commit.

The agent signals the engine with two markers: `UNGRIND_SUMMARY:` (the change summary) and `UNGRIND_BLOCKED: <reason>`. The engine counts the blocked marker as a failed attempt, so a cheap tier that gives up still escalates.

## Decisions on the open questions

- **Acceptance criteria**: required (at least one), but they do not have to be machine-checkable. The prompts and the planner push toward criteria a test or command can confirm.
- **Card quality**: `validate` plus `plan --task <id>` is the v1 card helper. Bad cards are blocked with a reason, never guessed at.
- **Push**: only if the configured remote exists. A push failure is logged and does not fail the task.

## Not in v1

Codex runner, notifications (the `gates.notify` config is parsed but nothing is sent yet), the cron wrapper with a usage pre-check, a benchmark set, improvement proposals, a board view, parallel runs, and auto-merge.

```bash
npm test
```
