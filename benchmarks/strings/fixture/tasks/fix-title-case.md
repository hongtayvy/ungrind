---
title: Fix titleCase
status: Ready
priority: 3
size: small
files: [src/strings.js, test/strings.test.js]
---
## Goal
`titleCase(text)` in `src/strings.js` capitalizes every word and handles empty or extra-spaced input.

## Acceptance criteria
- `titleCase("the quick brown fox")` returns `"The Quick Brown Fox"`
- `titleCase("")` returns `""` without throwing
- Repeated spaces are preserved: `titleCase("a  b")` returns `"A  B"`
- Tests cover all three cases and `npm test` passes
