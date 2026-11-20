# Ungrind

Project-agnostic loop engine for coding agents (repo hongtayvy/ungrind, MIT). It pulls one task card from a
task source, routes it to a model tier, runs the repo's checks, retries/escalates on failure, and logs everything.
The engine, not the model, decides whether the loop continues. Zero dependencies, ESM, Node >= 20, needs the
`claude` CLI logged in. Full design: `docs/design.md`. Read `SECURITY.md` before changing anything that runs
commands or agents.

## Commands
- Tests: `npm test` (node --test on `test/*.test.js`). CLI: `node bin/ungrind.js <cmd>`
  (`validate`, `run [--dry-run --task id --skip-conventions]`, `onboard`, `approve`, `plan`, `stats`, `cron`, `propose`/`proposals`/`accept`/`reject`, `bench`, `board`).
- Demo: `./examples/demo/setup.sh` creates `demo-sandbox/` (gitignored), then run `validate` / `run --dry-run` with `--config demo-sandbox/ungrind.config.yaml`.
- Real runs refuse to start until `.ungrind/conventions.md` is approved (`onboard` drafts, `approve` promotes).
- Mac app: `cd mac && ./scripts/build-app.sh` (needs Xcode, macOS 14+); tests `swift test`. Cannot be built from the Linux sandbox.
- Website: static, `python3 -m http.server 4173 --directory website/dist`.

## Layout
- `src/engine.js` the loop; `src/agents/{claude-code,codex,ollama,spawn}.js` agent adapters; `src/sources/{local,notion}.js` task sources;
  `src/verifiers/` checks; plus `config.js`, `rules.js`, `task.js`, `git.js`, `cron.js`, `board.js`, `bench.js`, `proposals.js`, `review.js`, `notify.js`, `doctor.js`, `onboard.js`, `runlog.js`, `yaml.js` (own YAML parser, no deps), `glob.js`.
- `prompts/v1` versioned prompts (bench results are keyed by prompt version). `benchmarks/strings/suite.yaml` is the bench suite.
- `mac/` SwiftUI front end that runs the Node engine as a child process; the engine stays the source of truth. `website/` product site. `docs/` design, mac-app plan, UI handoff.

## Invariants to preserve
- Never commits to main, never force-pushes, never merges; only the loop branch (e.g. `loop/<task-id>`) is pushed, and only if the remote exists.
- A run fails if it touches forbidden paths, files outside the card's scope, or too many files.
- Notion and ntfy tokens are never passed to agents or check commands. First pass and onboarding are read-only (Read, Glob, Grep).
- Routing: `agent.byTier` beats `agent.byType` beats `agent.adapter`; ladder default local -> haiku -> sonnet -> opus.
- Config files (`ungrind.config.yaml`) are executed with `sh -c`: treat them as code.
- `.ungrind/` (runs.jsonl may contain command output) and `benchmarks/*/results.jsonl` are gitignored.
- `mac/dist/` holds a built `Ungrind.app` and `stage.*` scratch dirs; do not read or edit them.
