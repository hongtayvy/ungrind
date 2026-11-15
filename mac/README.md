# Ungrind for Mac

A native SwiftUI front end over the Ungrind engine. The plan is in [docs/mac-app.md](../docs/mac-app.md). The Node engine stays the source of truth: the app runs it as a child process and never parses card or rules files itself.

## Build and run

Needs Xcode (macOS 14 or later) and Node 20+.

```bash
./scripts/build-app.sh
```

```bash
open dist/Ungrind.app
```

The script builds a release binary, wraps it in `dist/Ungrind.app`, copies the engine (`bin`, `src`, `prompts`) into the bundle, and signs it ad hoc. Add `--dmg` to also write `dist/Ungrind-<version>.dmg`. The DMG is not notarized, so on another Mac it needs right-click → Open the first time.

To work on it in Xcode, open `mac/Package.swift`. Tests:

```bash
swift test
```

## How it talks to the engine

| App action | Engine command |
|---|---|
| Add a folder | `ungrind find-config --dir <folder>` |
| Set Up Ungrind Here | `ungrind init --dir <folder>` (writes `ungrind.config.yaml` and `tasks/`; never overwrites) |
| Load or reload | `ungrind state --config <file>` (rules, cards with route and problems, runs) |
| Create or edit a card, route override, archive | `ungrind card-save --config <file>` with JSON on stdin |
| Ship / Dry Run | `ungrind run --config <file> --task <id> [--dry-run]`, log streamed line by line |

Node is found by asking your login shell (`$SHELL -ilc`), because apps launched from Finder get a bare `PATH`. The same `PATH` is passed to the engine so it can find `claude`, `codex`, and `git`.

## What works today

- **Three columns:** folders, the folder's feature cards (Active / Shipped / Archived), and the selected card's goal, scope, route, rules, and last run.
- **Cards:** create and edit in the app. Cards are the same markdown files the CLI uses, so edits in your editor show up when you return to the app.
- **Route overrides per card:** start tier and agent ("run local first", "straight to Codex"). Bad overrides show as card problems and block the run.
- **Rules:** shown per folder, read from `ungrind.config.yaml`. "Open Rules File" opens it in your editor.
- **Ship button:** one click runs the card through the engine with a live log. Dry Run does the same without pushing or changing the card.
- **Menu bar item:** shows the current or last run and can stop it.

## Not built yet (from the plan)

- **First-pass feature parsing:** reading an existing repo and drafting its feature cards. Setup currently creates an empty `tasks/` folder.
- **Editing rules in the app:** rules are read-only in the app; edit the file.
- **Shipped on push, Archived after merge:** today Shipped means the engine marked the card Done (checks passed, branch pushed when a remote exists). Archive is a manual action.
- **Compacting card history.**
- **Onboarding in the app:** the conventions draft and approval still run from the CLI (`ungrind onboard`, `ungrind approve`). Ship asks before running without one.
- **Bundled Node:** the app uses the Node already on your Mac.
- **Notarized DMG, MCP-driven folders, and versioned folders without git.**
