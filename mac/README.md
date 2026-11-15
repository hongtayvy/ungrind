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

## Design

The look follows the UI handoff in `docs/ui-handoff/` ("quiet momentum"): three calm columns, system type, native controls, and one accent, amber `#EA9828`. Tokens and shared styles live in `Sources/Ungrind/DesignSystem.swift` and adapt to light, dark, and Increase Contrast. Warnings use a rust tone so they don't read like the amber accent.

To check an appearance without changing your system setting:

```bash
open dist/Ungrind.app --env UNGRIND_APPEARANCE=dark
```

## How it talks to the engine

| App action | Engine command |
|---|---|
| Add a folder | `ungrind find-config --dir <folder>` |
| Set Up Ungrind Here | `ungrind init --dir <folder>` (writes `ungrind.config.yaml` and `tasks/`; never overwrites) |
| Read This Folder (first pass) | `ungrind discover --config <file>` (read-only run on the strongest tier) |
| Edit Rules… | `ungrind rules --config <file>` to load, `ungrind rules-save` with JSON on stdin to save (validated first, previous version kept in `.ungrind/rules.backup.yaml`) |
| Load or reload | `ungrind state --config <file>` (rules, cards with route and problems, runs) |
| Create or edit a card, route override, archive | `ungrind card-save --config <file>` with JSON on stdin |
| Ship / Dry Run | `ungrind run --config <file> --task <id> [--dry-run]`, log streamed line by line |

Node is found by asking your login shell (`$SHELL -ilc`), because apps launched from Finder get a bare `PATH`. The same `PATH` is passed to the engine so it can find `claude`, `codex`, and `git`.

## What works today

- **First pass:** "Read This Folder" has your strongest model read the repo and write feature cards. Features that already exist land in Shipped; unfinished work it finds evidence for (TODOs, known bugs, things the README promises) lands in Active as drafts. A draft can't run until you click Mark Ready.
- **Three columns:** folders, the folder's feature cards (Active / Shipped / Archived), and the selected card's goal, scope, route, rules, and last run.
- **Cards:** create and edit in the app. Cards are the same markdown files the CLI uses, so edits in your editor show up when you return to the app.
- **Route overrides per card:** start tier and agent ("run local first", "straight to Codex"). Bad overrides show as card problems and block the run.
- **Rules editor:** "Edit Rules…" (also ⇧⌘R) edits the project's checks, off-limits paths, limits, route (tiers, start tier per card size, local model), default agent, review, approval types, and branch name. It writes `ungrind.config.yaml`, so the app and the file stay in sync; "Open Rules File" still opens the file in your editor. Invalid rules are refused with the reason and nothing is written. "Reset to Ungrind Defaults" restores the base rules and keeps your checks. Saving from the app drops comments inside the file (the comment block at the top is kept), and settings the editor doesn't show (task source, notifications, cron, per-type agents) are left as they are.
- **Ship button:** one click runs the card through the engine with a live log. Dry Run does the same without pushing or changing the card.
- **Menu bar item:** shows the current or last run and can stop it.

## Not built yet (from the plan)

- **Shipped on push, Archived after merge:** today Shipped means the engine marked the card Done (checks passed, branch pushed when a remote exists). Archive is a manual action.
- **Compacting card history.**
- **Onboarding in the app:** the conventions draft and approval still run from the CLI (`ungrind onboard`, `ungrind approve`). Ship asks before running without one.
- **Bundled Node:** the app uses the Node already on your Mac.
- **Notarized DMG, MCP-driven folders, and versioned folders without git.**
