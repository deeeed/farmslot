# Roadmap refinement task

Roadmap item: {{ROADMAP_ITEM_ID}}
Project: {{PROJECT}}
Target projects: {{TARGET_PROJECTS}}
Stage: {{STAGE}}
File: {{FILE_PATH}}
Tags: {{TAGS}}
Refinement runner: {{RUNNER}}
Refinement model: {{MODEL}}

## Farmslot framework context

{{FARMSLOT_CONTEXT}}

This is an interactive planning/refinement session inside the Farmslot
framework, not an implementation run.

Before changing the roadmap markdown file, show the operator a concise proposed
refinement and ask what to do next. Offer choices equivalent to:

1. Apply the refined roadmap markdown to the item.
2. Revise the draft before writing.
3. Leave the roadmap file unchanged.

Only edit the roadmap markdown file after the operator confirms that choice.
Never overwrite the rough idea silently.

Do not create ADRs automatically. If an ADR seems necessary, add an ordinary
markdown note for the developer to handle manually.

## Reference verification

Before drafting final backlog content from GitHub PR or issue URLs, verify those
references with authenticated local tooling when available:

- For GitHub PR URLs, prefer `gh pr view <number> --repo <owner>/<repo> --json title,body,state,mergedAt,headRefName,baseRefName,files,commits`.
- If `gh` hits a network/auth/sandbox approval boundary, ask the operator before
  falling back to unverified assumptions.
- Do not say a PR cannot be verified until authenticated `gh` has been tried or
  the operator declines that lookup.
- Summarize which references were verified and which remain unverified before
  asking to apply the roadmap edit.

Hard boundaries:

- Work only inside the Farmslot repository.
- Treat `farmslot roadmap --help` as the discoverable command surface. In this
  dev checkout, use the provided `yarn workspace @farmslot/cli farmslot ...`
  command form when shown below; in an installed environment the equivalent is
  `farmslot ...`.
- The promotion request command shown below is local/file-backed and does not
  contact the gateway. Do not run gateway-backed Farmslot commands during
  roadmap refinement unless the operator explicitly asks.
- Do not launch project dev servers, Metro, webpack, browsers, simulators,
  emulators, recipe runners, sandbox validation, package installs, or Farmslot
  slot dispatch.
- Do not modify MetaMask client repositories or temporary checkout directories.
- Do not create tmux windows or background processes.
- Do not implement client code. The expected output is refined planning
  markdown that can later be promoted into backlog items.

## Output contract

The refined roadmap item should include:

- `## Problem`
- `## Proposed Solution`
- `## Non-goals`
- `## Risks`
- `## Dispatch Notes`
- `## Acceptance Criteria`

When the file satisfies this contract, update the roadmap item frontmatter to
`stage: "refined"` and refresh `updatedAt`. Leave it as `stage: "refining"`
only if important information is still missing.

When target projects are listed, include a `## Backlog Drafts` section with one
dispatch-ready draft per target project. Use this exact shape for each draft;
do not repeat the title as both a heading and a separate `Title:` line:

```markdown
### Backlog Draft: <clear dispatch title>

Project: `<target-project>`
Tags: `<tag>`, `<tag>`

#### Implementation Notes

- ...

## Acceptance Criteria

- ...

#### References

- ...
```

Each draft must include a promotion-valid `## Acceptance Criteria` section and
references needed by a future runner. Do not dispatch them yourself.

When the roadmap item is refined and the backlog drafts are ready, ask the
operator whether to request promotion review. If they confirm, request human
promotion with:

```sh
{{PROMOTION_REQUEST_COMMAND}}
```

Run that command at most once. It creates a Farmslot/Command Center human
decision only; it does not create backlog items. Do not promote, create, or
dispatch backlog items yourself.

For final verification, reread the roadmap markdown and the promotion decision
file if one was created. Do not rely on `git diff` alone because roadmap inbox
files may be untracked or ignored.

Keep boundaries clear:

- Roadmap items can begin as rough ideas and mature into refined project or epic specs.
- Backlog items are dispatch-ready implementation tickets with explicit acceptance criteria.
- One roadmap item may promote into multiple backlog specs; do not collapse multi-concern work into one ticket.
- If target projects are listed, produce project-specific dispatch boundaries and backlog specs.
- Use shared tag semantics across roadmap, backlog, queue, and runs.
- Favor simple dispatchable slices over architecture-heavy plans.

## Current roadmap markdown

{{CURRENT_MARKDOWN}}
