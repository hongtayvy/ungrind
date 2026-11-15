# Ungrind

Ship your side projects without the grind.

Ungrind is a project-agnostic loop engine for coding agents. It pulls one task from a task source, routes it to a model tier, runs your checks, retries and escalates on failure, and logs everything. Each repo plugs in with one config file. The model never decides whether the loop continues; the engine does.

Zero dependencies. Node 20+ and the `claude` CLI (logged in) are all you need.

The full design and scope (V1, V2, Someday) is in [docs/design.md](docs/design.md).

Read [SECURITY.md](SECURITY.md) before pointing Ungrind at a project you didn't write: it runs agents and shell commands on your Mac.

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
| `stats` | Pass rates per prompt and conventions version, plus per tier / agent / model, from `.ungrind/runs.jsonl` |
| `cron [--print-crontab]` | Scheduled entry point: lock, usage pre-check, then up to `cron.maxTasksPerRun` tasks |
| `propose` / `proposals` / `accept id` / `reject id` | Improvement proposals from the run log, applied only on human approval |
| `bench [--fixture-config f] [--compare]` | Rerun the benchmark suite and compare prompt versions |
| `board [--port n] [--out file]` | Read-only board of tasks and recent runs, localhost only |

On a new repo, run `onboard`, read and edit the draft, then `approve`. Real runs refuse to start until a conventions file is approved.

## V2

### Local models first (Ollama)

Put a local model on the bottom rung. A task tries it first and escalates to haiku → sonnet → opus when checks fail. Local attempts log `$0`, so `stats` and `bench` compare them directly with the paid tiers.

```yaml
routing:
  ladder: [local, haiku, sonnet, opus]
  tierBySize: { small: local, medium: local, large: sonnet }
agent:
  byTier: { local: ollama }
  ollama:
    models: { local: "qwen3.6-coding-16k:latest" }   # must already be installed (`ollama list`)
    maxTurns: 40
```

Ollama serves models, not agents, so the adapter runs a small tool loop over `/api/chat`. The model gets five tools: `list_files`, `read_file`, `write_file`, `replace_in_file`, and `run_checks` (only the configured verifiers). It has no shell, and every path stays inside the repo, outside `.git`. A missing model is an error: Ungrind never pulls models. See `examples/demo/ungrind.local.yaml`.

### Agents per tier or task type, and Codex

`agent.byTier` beats `agent.byType` beats `agent.adapter` (default `claude-code`). Claude tiers take models from `routing.models`; other adapters take them from `agent.<adapter>.models` (Codex falls back to its own default model).

```yaml
agent:
  byType: { ui: codex }
  codex:
    models: { sonnet: <codex model> }
    pricing: { inputPerMTok: 1.25, outputPerMTok: 10 }   # optional; Codex reports tokens, not dollars
```

The Codex adapter runs `codex exec --json --ephemeral --skip-git-repo-check -C <repo> -s workspace-write -` with the prompt on stdin, per OpenAI's non-interactive docs. Without `pricing`, Codex attempts log $0 and the cost ceiling can't see them.

### Cross-vendor review

```yaml
review:
  agent: codex        # a different family than the builder catches what self-review misses
  blocking: true      # FAIL or no verdict = failed attempt; issues go into the retry prompt
```

After the checks pass, the reviewer reads the task and the diff (read-only) and ends with `UNGRIND_REVIEW: PASS` or `FAIL` plus issues. In non-blocking mode, the issues are appended to the summary instead.

### Notifications and cron

```yaml
gates:
  notify: { ntfyTopic: my-topic, server: https://ntfy.sh, tokenEnv: NTFY_TOKEN, on: [done, blocked, skipped, ceiling] }
cron:
  maxTasksPerRun: 1
  dailyUsd: 5            # budgets come from the run log (Claude Code's cost estimate on a subscription)
  weeklyUsd: 25
  maxRunsPerDay: 10
  precheckCommand: null  # your own usage check; non-zero exit skips the run
```

`ungrind cron --print-crontab` prints a crontab line with absolute paths. It does not install it. A lock file stops overlapping runs.

### Benchmarks and improvement proposals

- `bench` runs `benchmarks/strings/suite.yaml`. Each case runs in a fresh temp git copy of the fixture, and results go to `results.jsonl` keyed by prompt version. Pass `--prompts-dir/--prompts-version` to benchmark a candidate prompt set before adopting it.
- `propose` groups failed attempts by cause from the run log. Once there are at least `--min-failures` (default 3) new ones, the strongest tier drafts one conventions addition. The engine writes the evidence into the proposal itself. `accept` backs up the conventions file and appends the addition; `reject` closes the proposal. Runs record a conventions hash, so `stats` compares results before and after an accepted change.

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
src/agents/               runner interface + routing (index.js), claude-code.js, codex.js, ollama.js
src/review.js             cross-vendor diff review
src/notify.js, cron.js    ntfy alerts; cron wrapper with lock and usage pre-check
src/bench.js              benchmark suite runner and comparison
src/proposals.js          evidence-backed conventions proposals with human approval
src/board.js              read-only board (localhost server or static HTML)
benchmarks/strings/       benchmark suite + fixture repo
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

## Not in scope

Parallel task execution, auto-merge of any kind, and self-modifying prompts or configs. Proposals only change the conventions file after `accept`, and template changes are ordinary human commits. Someday: a PromptOut adapter for prompts, more task sources (GitHub Issues, Linear, Jira), and more verifier types.

```bash
npm test
```
