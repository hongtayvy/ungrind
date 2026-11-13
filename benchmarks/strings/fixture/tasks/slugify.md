---
title: Add slugify helper
status: Ready
priority: 1
size: small
files: [src/strings.js, test/strings.test.js]
---
## Goal
`src/strings.js` exports a `slugify(text)` function that turns any title into a URL-safe slug.

## Acceptance criteria
- `slugify("Hello, World!")` returns `"hello-world"`
- Leading, trailing, and repeated separators are collapsed
- Unit tests in `test/strings.test.js` cover both cases and `npm test` passes
