# Roadmap refinement task

Roadmap item: {{ROADMAP_ITEM_ID}}
Project: {{PROJECT}}
Stage: {{STAGE}}
File: {{FILE_PATH}}
Tags: {{TAGS}}
Refinement runner: {{RUNNER}}
Refinement model: {{MODEL}}

Refine the roadmap markdown file in-place. Do not create ADRs automatically.
If an ADR seems necessary, add an ordinary markdown note for the developer to handle manually.

## Output contract

The refined roadmap item should include:

- `## Problem`
- `## Proposed Solution`
- `## Non-goals`
- `## Risks`
- `## Dispatch Notes`
- `## Acceptance Criteria`

Keep boundaries clear:

- Roadmap items can begin as rough ideas and mature into refined project or epic specs.
- Backlog items are dispatch-ready implementation tickets with explicit acceptance criteria.
- One roadmap item may promote into multiple backlog specs; do not collapse multi-concern work into one ticket.
- Use shared tag semantics across roadmap, backlog, queue, and runs.
- Favor simple dispatchable slices over architecture-heavy plans.

## Current roadmap markdown

{{CURRENT_MARKDOWN}}
