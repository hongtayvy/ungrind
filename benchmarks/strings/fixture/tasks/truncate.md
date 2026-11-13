---
title: Add truncate helper
status: Ready
priority: 2
size: small
files: [src/strings.js, test/strings.test.js]
---
## Goal
`src/strings.js` exports `truncate(text, max)` that shortens text to at most `max` characters, ending with an ellipsis when cut.

## Acceptance criteria
- `truncate("abcdef", 4)` returns `"abc…"` (the result is exactly `max` characters)
- Text at or under `max` is returned unchanged
- Tests cover both cases and `npm test` passes
