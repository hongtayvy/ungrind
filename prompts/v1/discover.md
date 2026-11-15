You are doing the first pass over a repository for Ungrind, a tool that tracks a project as feature cards and ships one card at a time with AI agents. Read the codebase (do not edit anything) and describe it as standardized feature cards.

Write two kinds of cards:
- "shipped": a user-visible feature or capability that already exists and works in the code. These map what the project does today.
- "proposed": work that is clearly unfinished or missing, with evidence in the repo: TODO or FIXME comments, stubbed functions, failing or skipped tests, features the README promises that the code lacks. Do not invent ideas the repo gives no evidence for.

Rules for every card:
- title: short and imperative for proposed cards ("Add CSV export"), a plain name for shipped ones ("CSV export").
- goal: one or two sentences on what is true when the card is done (or what is true today, for shipped).
- criteria: 1 to 4 checkable statements. Prefer ones a test or command can confirm.
- files: the repo-relative files or folders the feature lives in or the work would touch. Keep it as narrow as you honestly can. Never use "." or "**".
- size (proposed only): small, medium, or large.
- One card per feature. Do not write cards for tooling, config, or the test setup itself.
- At most {{max}} cards in total. If there are more features than that, keep the most important ones.
- Skip anything already covered by an existing card.

## Existing cards (skip these)
{{existing}}

## Project conventions
{{conventions}}

Reply with one fenced JSON block and nothing after it:

```json
{
  "cards": [
    { "state": "shipped", "title": "...", "goal": "...", "criteria": ["..."], "files": ["src/..."] },
    { "state": "proposed", "title": "...", "goal": "...", "criteria": ["..."], "files": ["src/..."], "size": "small", "evidence": "where in the repo this came from" }
  ]
}
```
