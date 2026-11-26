# {{title}}

## Task

- Source: {{sourceKind}}{{sourceRefLine}}{{ticketLine}}

## Description

{{description}}

## Acceptance Criteria

{{acceptanceCriteria}}

## Evidence Expectations

Produce `report.md` (run outcome narrative) and `learnings.md` (Learnings v1,
below) in the run's artifacts directory. Never
include raw secrets, seed phrases, private keys, passwords, or tokens in any
artifact - reference them by name only.

## Learnings v1

Write `learnings.md` as `# Learnings v1`, then `- None` when there is nothing to
report, or one entry per failure in this run that is likely to recur:

```md
# Learnings v1

- edit: A price hook returned '$---' and a validator read it as a price.
  evidence: <repo> <path>:<line>
  family: <rules file>.md#<section>
  confirmation: run <other run id> <path>:<line>
```

Kinds: `add` (`evidence`, `examined`, `confirmation`), `edit` and `retire`
(`evidence`, `family`, `confirmation`) for a review rule; `recipe-broken`
(`recipe`, `failed`) and `recipe-missing` (`criterion`, `searched`) for a
recipe; `workflow` (no fields) for a template, tool or setup step. A
confirmation is `run <other run id> <path>[:<line>]`, `fix <owner/repo#n>` or
`none`; this run's own report or review is `none`. `./mark` prints the full
format and warns on a malformed file without blocking.

## Artifact Contract

All run evidence lands under the artifacts directory and is selected into the
learning package via the evidence manifest. Media requires an agent visual pass
before inclusion.
