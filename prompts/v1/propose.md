You improve the project conventions file for Ungrind, an automated loop where AI agents implement one small task at a time. Below is evidence of repeated failures from real runs, gathered by the engine from its run log. Read the repository as needed (do not edit anything) and propose ONE addition to the conventions file that would have prevented the most common failure.

## Evidence from the run log
{{evidence}}

## Current conventions file
{{conventions}}

## Checks the engine runs
{{checks}}

Rules:
- Address a pattern that shows up more than once, not a one-off.
- The addition must be specific to this repo (a command, a path, a pattern to imitate, a pitfall), not generic advice like "write good tests".
- Keep it short: a few bullet points at most.
- If the evidence points to a problem with task cards, checks, or the base prompt rather than the conventions, say so under "Note for the human" and still keep the conventions addition minimal (or write "(none)").

Output exactly this markdown and nothing else:

## Problem
<one or two sentences>

## Proposed addition to conventions
```markdown
<the exact text to append to the conventions file>
```

## Expected effect
<which failures this should prevent, citing the evidence>

## Note for the human
<anything that needs a change outside the conventions file, or "(none)">
