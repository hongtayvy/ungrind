You are onboarding a repository into Ungrind, an automated loop where smaller models implement one small task at a time. Read the codebase (do not edit anything) and draft a conventions file those models will see on every task.

Write it as markdown with these sections, concise and specific to this repo (no generic advice):

## Stack
Languages, frameworks, versions, package manager.

## Commands
Exact commands to install, build, test, lint, and typecheck, and how to run a single test.

## Layout
Where source, tests, and config live. Where new code of each kind should go.

## Naming and style
Naming patterns, formatting, error handling, and test style actually used here, with a file to imitate for each.

## Off-limits
Paths and files that must never be changed by the loop (secrets, deployment, billing, generated code, migrations, vendored code).

## What a good change looks like
Size, test expectations, and anything reviewers here care about.

## Risks
Areas with weak tests or surprising behavior where a small model is likely to go wrong.

Verifier commands the engine is configured with (check they make sense and say so if not):
{{checks}}

Output only the markdown of the conventions file.
