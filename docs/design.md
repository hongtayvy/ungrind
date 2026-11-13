# Ungrind: Reusable Loop Engine (Build Brief)

Ungrind — ship your side projects without the grind.

**Project name:** Ungrind. **Positioning:** less grind for engineers with a day job and a graveyard of half-built ideas. The claim stays modest: it reduces the grind of finishing features, it does not fix burnout.

## Goal

Build a reusable, project-agnostic loop engine that pulls tasks from a pluggable task source (local files and Notion in v1, more later), routes each to the right model tier, verifies the result, escalates on failure, and logs everything. Each project plugs in via a small config file. Adding a new repo means writing a config, not changing the engine.

PromptOut's cron-triggered Claude Code loop was the prototype. Ungrind replaces it with a cleaner split: a project-agnostic engine, a per-project config, and swappable adapters for task sources, agents, and prompts.

## Scope: V1, V2, Someday

### V1: prove the loop works

- config loader and schema validation
- task contract with validation before every run
- task source adapters: local files (also reads an Obsidian vault) and Notion
- Claude Code runner with model tier selection
- verifier runner with the command check and the diff guard
- retry, escalation, and stop logic
- run logging with prompt version, tier, attempts, and result
- dry-run mode
- standard base prompt as plain files in the repo
- basic onboarding: the strong model drafts the conventions file and the human approves it

### V2: widen it once the core works

- Codex runner and cross-vendor review
- **local models: an Ollama runner as an optional first tier before haiku, sonnet, opus** (see [Local models](#local-models-ollama))
- notifications and the cron wrapper with the usage pre-check
- benchmark set for comparing prompt versions
- improvement proposals from run logs, with human approval
- read-only board view over task files and run logs

### Someday

- PromptOut adapter for pulling prompts at run time
- more task sources: GitHub Issues, Linear, Jira
- more verifier types: LLM-as-judge, Playwright UI checks, characterization tests for legacy code
- non-code automation, such as folders of media or documents with their own verifiers

Notion is in V1 because the PromptOut loop already runs on it, so Ungrind can replace that loop early.

## Architecture

**Engine** (deterministic, outside the model): owns the task queue, retry counts, routing, escalation, verifier execution, logging, and stop conditions. The model never decides whether the loop continues.

**Project config** (one per repo): declares everything project-specific. The engine treats a Spring Boot repo and a React repo identically because every check follows the same contract.

**Skill files** (optional): hold how-to knowledge per project, such as conventions and what a good change looks like. They inform the agent but do not enforce anything.

## One run, step by step

1. Read the project config.
2. Validate the task against the task contract (blocked with a reason if it fails). Query the task source for the highest-priority task with status Ready whose dependencies are Done. If none, log "nothing ready" and exit.
3. Set the task to In progress.
4. Create a branch named per the config rule (for example `loop/<task-slug>`). Never commit to main, never force push, never merge.
5. Start the task at its assigned model tier (default: Haiku for small, Sonnet for medium, Opus for planning or large tasks). When a local tier is configured, small and medium tasks can start on the local model instead.
6. Run the agent headless against the task, with the notes file for that task included so it does not repeat failed attempts.
7. Run the verifier commands in order.
8. If all pass: commit, push the branch, write the change summary, set the task to Done.
9. If any fail: append the failure output to the task notes file, increment the attempt counter at this tier, and retry. After two failures at a tier, escalate to the next tier (local, then Haiku, Sonnet, Opus). After the max attempts per task, set the task to Blocked with a one-line reason and stop.
10. Log the full trajectory (prompt version, tier used, agent and model, attempts, verifier output, duration, cost estimate; local attempts log $0). In v2, also send a notification.

## Config schema

Five sections.

### 1. Identity and task source

- project name, repo path
- task source adapter (local files or Notion) and its settings, such as folder path or Notion database ID
- status names that map to ready, in progress, done, blocked

### 2. Verifier contract

- ordered list of checks, each with: name, command, working directory, timeout, pass condition (default: exit code zero)
- examples: build, unit tests, lint, typecheck, app startup check

### 3. Guardrails

- forbidden paths (secrets, billing, deployment config, production env vars)
- branch naming rule
- no force push, no merge, never touch main
- max attempts per task

### 4. Routing rules

- starting tier by task size label
- escalation ladder (Haiku, then Sonnet, then Opus) triggered after two verifier failures at a tier
- optional local first tier: the ladder becomes local, Haiku, Sonnet, Opus, with the local tier mapped to the Ollama runner and an installed model
- the agent per tier or task type (Claude Code by default; Codex or Ollama where configured)
- per-run usage or cost ceiling that stops the run when hit

### 5. Human gates and notifications

- task types that always pause for approval (auth, payments, data migrations)
- notification target (reuse the existing ntfy setup) and what triggers an alert: done, blocked, skipped, ceiling hit

**Definition of done beyond tests:** the agent must write a short summary of what changed and why, attached to the task through the task source adapter, so review is fast.

## Task contract

The task contract is the most fragile part of the system. Every task source adapter maps onto this one schema, and a vague card is where cheap tiers quietly go wrong. The engine validates every task against the contract before running it, and marks a task blocked with a reason if it fails validation, instead of guessing.

| Field | Required | Purpose |
|---|---|---|
| Title | Yes | Short name for the task, also used in the branch name. |
| Goal | Yes | One or two sentences on what should be true when the task is done. |
| Acceptance criteria | Yes | Checkable statements the verifier or reviewer can confirm. At least one. |
| Files in scope | Yes | Paths or folders the task may touch. The diff guard fails anything outside them. |
| Status | Yes | Ready, in progress, done, or blocked. Mapped per adapter. |
| Priority | Yes | Orders the queue. |
| Dependencies | No | Tasks that must be done first. |
| Size or tier hint | No | Starting tier suggestion. The engine can override it. |
| Notes | Engine-written | Failure output and attempts, so retries do not repeat mistakes. |
| Summary | Engine-written | What changed and why, written at the end for fast review. |

**Adapter mapping:**

- **Local files:** one markdown file per task with these fields as front matter at the top and the goal and criteria in the body.
- **Obsidian:** the same format, since notes are markdown files with properties. The local files adapter should read a vault folder with no extra work.
- **Notion:** one database row per task, with a property per field. The adapter needs a status name mapping.

**Open questions:** whether acceptance criteria should be required to be machine-checkable where possible, and whether a task template or generator should help write well-formed cards.

## Prompt management

The prompt does not disappear in a loop, it moves. The engine assembles prompts from versioned templates instead of free text, and improves them using run evidence.

**Templates with slots (v1):**

- one base prompt per model tier (including the local tier when configured), plus a planner prompt and a retry prompt
- the engine fills slots: task card, files in scope, project conventions from the skill file, and failure notes from earlier attempts
- the retry prompt carries the exact verifier output, which is often the most useful prompt in the loop
- templates are plain files in the repo under version control, so anyone can clone and run with nothing else installed

**Well-formed task cards:** each task needs a clear goal, acceptance criteria, and files in scope. The planner's real job is turning fuzzy tasks into crisp ones, since cheap tiers do far better with tight cards.

**Evidence-driven improvement:**

- log the prompt version, tier, attempts, and pass or fail on every run
- compare first-try pass rates across prompt versions
- keep a small benchmark set of tasks that is rerun whenever a prompt changes, working like a regression suite

**Guardrail:** the agent never rewrites its own prompts unattended. Prompt changes are proposed and approved by a human.

**Later: PromptOut adapter.** PromptOut is the capture-and-standardize layer for prompts, served through an MCP server. A later adapter lets Ungrind pull its tier templates, planner prompt, and retry prompt from PromptOut at run time, following the same pattern as the task source and agent runner adapters. Not required for v1.

## Project onboarding and prompt improvement

Prompts cannot be written in advance for projects the engine has not seen. So Ungrind ships a generic base prompt and builds the project-specific layer when a repo is first connected, then improves it from real runs.

**Layer 1: standard base prompt (ships with Ungrind).** Project-agnostic rules that work anywhere: do one task, stay in scope, run the configured checks, write a short change summary, and mark the task blocked instead of guessing. Built and tested before any project is connected.

**Layer 2: project conventions file (generated at onboarding).** When a new repo is connected, a one-time onboarding run uses the strong model to read the codebase and draft a conventions file covering the stack, build and test commands, naming patterns, off-limits paths, and what a good change looks like. The human reviews and approves it before it is used. Every later prompt includes it.

**Layer 3: improvement from runs.** Verifier output, failure notes, and repeated mistakes from real attempts are collected as proposed additions to the conventions file or base prompt. Each proposal shows the evidence behind it, and nothing changes until a human approves it. Prompt versions are tracked so first-try pass rates can be compared before and after a change.

**Build order impact:** the onboarding run and the approval step come before the first real task on any new repo. The improvement proposals can wait until there are enough logged runs to learn from.

## Agent runner adapters

The engine should also treat the coding agent as a swappable backend. It talks to a small agent runner interface, and each agent is an adapter behind it. v1 ships with Claude Code only, but the interface is designed in from the start so adding another agent does not touch the engine.

**Interface:** run a task prompt headless in a given working directory with a given model tier, and return the output, exit status, and usage.

**Adapters:**

- **Claude Code (v1):** headless CLI mode under the user's existing login, or the API for server use.
- **Codex (v2):** its non-interactive CLI mode. Confirm the exact headless flags before building.
- **Ollama (v2):** local models on the user's machine, as an optional first tier. See below.

**What this unlocks:**

- **Cross-vendor review:** one model family builds, a different one reviews the diff, which catches mistakes a model grading its own work tends to miss.
- **Routing by strength:** for example, Claude Code for scope-heavy backend work and Codex for UI and brand-heavy tasks.
- **Local first:** cheap, private attempts on a local model before any paid tier is spent.
- The project config names the agent per task type or tier.

### Local models (Ollama)

An Ollama runner sits behind the same runner interface as Claude Code and Codex. It is optional and off by default.

- **Optional first tier.** The config can add a `local` tier at the bottom of the ladder, so the ladder becomes local, Haiku, Sonnet, Opus. A task tries the local model first; after two verifier failures at the local tier it escalates to Haiku, then Sonnet, then Opus, exactly like any other rung. Without the local tier, routing is unchanged.
- **Installed models only.** The config names a model that is already installed in Ollama (`ollama list`). The engine checks it is installed before each local attempt and fails that attempt with a clear message if it is not. Ungrind never pulls or downloads models; pulling a new model is the human's decision.
- **Logged at $0.** Local attempts record a cost of $0 (with token counts) in the run log, so stats and the benchmark set can compare local pass rates, attempts, and time directly against the paid tiers.
- **Same guardrails.** Ollama serves models, not agents, so the adapter runs a small tool loop of its own. The local model gets file tools scoped to the repo and a tool that runs the configured checks, with no general shell. The diff guard, verifiers, and stop logic apply unchanged.

## Task source adapters

The engine never talks to Notion directly. It talks to a small task source interface, and each backend is an adapter behind it. This keeps the engine reusable and lets anyone run it without a Notion account.

**Interface (three operations):**

- get the next ready task (highest priority, dependencies done)
- update a task's status (ready, in progress, done, blocked)
- attach a note or change summary to a task

**Adapters:**

- **Local files (default for v1):** tasks are markdown or YAML files in a `tasks/` folder inside the repo, with status stored as a field. No account or API keys, so anyone can clone it and run a demo in minutes. This is also the best portfolio demo.
- **Notion (v1):** second adapter, used for PromptOut and personal projects.
- **Later:** GitHub Issues, Linear, Jira.

The project config names which adapter to use and passes its settings (folder path, or Notion database ID and status mapping). A future board view could be a read-only UI over the local task files and run logs.

## First two verifier checks to implement

1. **Command check:** runs a configured shell command, passes on exit code zero, fails on timeout, captures stdout and stderr for the retry prompt.
2. **Diff guard check:** inspects the git diff and fails if any changed file matches a forbidden path, or if the diff touches far more files than the task plausibly needs.

Later checks to consider: characterization or regression tests for legacy code, an LLM-as-judge review of the diff against the task description, and a UI check via Playwright for web projects.

## Build order

1. Config loader and schema validation.
2. Task contract and its validation.
3. Task source interface with the local files adapter first, then the Notion adapter.
4. Headless Claude Code runner with tier selection.
5. Verifier runner with the command check and the diff guard.
6. Retry, escalation, and stop logic.
7. Run logging with prompt version, tier, attempts, and result.
8. Dry-run mode that does everything except push and status changes, for testing.
9. Standard base prompt files and the basic onboarding run with human approval of the conventions file.
10. V2 starts here: notifications, the cron wrapper with a usage pre-check so runs skip when the subscription is tight, then the Codex runner, the Ollama runner as an optional local first tier, benchmark set, and improvement proposals.

## Out of scope for v1

- Dashboards or web UI (a read-only board view is a v2 idea).
- Parallel task execution.
- Auto-merge of any kind.
- Self-modifying prompts or configs.

## Risks and open questions

- Weak verifiers let the loop converge on wrong answers. Projects with thin test coverage need characterization tests first.
- Cheap-tier models can fail quietly on subtle work, so verify the escalation thresholds against real runs.
- Local models vary widely in tool calling and coding ability, and a large local model can be slow. Use the benchmark set to decide whether the local tier earns its place for a given project before starting real tasks on it.
- Confirm which model names and headless options are actually available before wiring up routing.
- Decide whether the first target project is PromptOut (easiest, and already runs on Notion) or the Spring Boot migration (best portfolio story, but needs test coverage first). Also decide whether acceptance criteria must be machine-checkable where possible.
