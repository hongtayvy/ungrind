# Ungrind for Mac

A native front end over the Ungrind engine: point it at a folder, see its feature cards, ship one. Not another VS Code: you look at the repo and its cards; code opens in your own editor.

## Basics
- Swift app, tested in Xcode. Runs the Node engine as a bundled process and reads .ungrind/runs.jsonl for status and cost.
- Distributed as a DMG download, not the App Store yet.

## Projects and cards
- A project points at a directory. The first pass reads it and parses its features into standardized feature cards.
- Cards can be created and edited in the app.
- Tabs: Active, Shipped, Archived.
- A code card moves to Shipped on git push, and to Archived after merge (to confirm).
- Open question: how to compact a card's history over time.

## Rules engine (the heart)
- Ungrind ships a base rules framework as the default.
- Rules are editable in the app and as files in the folder; both stay in sync.
- A card can override the default, e.g. run local first or go straight to Codex.
- Rules check for missing scope and keep work inside a card's scope.

## Main screen
Three columns: folders on the left, the folder's feature cards in the middle, the selected card's route, rules and last run on the right. Shipping is one button.

## Later
- Drive any folder whose tools expose MCP (e.g. Adobe).
- Without git, each run writes a versioned folder (V1, V2) plus a markdown file listing its cost.
