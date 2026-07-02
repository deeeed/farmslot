---
name: fs-release-cut
description: Succinct release-needed signal and manual release-cut workflow for Farmslot workspaces (Command Center, gateway, protocol, companion, npm packages). Run release-status first; curate Unreleased bullets; cut with reviewed proposal.
---

# FS Release Cut

Developer tool for **when to cut a release** and **how to finalize changelogs** in the Farmslot monorepo.

Not part of slot lifecycle or dispatch. Use before hosted CC deploys, Companion EAS updates, or npm publishes.

## Step 1 — Scan (deterministic)

From a Farmslot checkout:

```bash
yarn release:status
```

Read the one-line verdict per group:

| Verdict | Meaning                                                    |
| ------- | ---------------------------------------------------------- |
| `NO`    | Only placeholders or nothing meaningful in `## Unreleased` |
| `SOON`  | A few bullets; wait for the current PR batch to land       |
| `YES`   | Operator-facing changes ready — cut before deploy/announce |

## Step 2 — Curate proposal

Pick a release group:

- `hosted-cc` — Command Center UI, gateway, protocol
- `companion` — Mobile Companion
- `npm` — published packages

Generate a proposal (rule-based split + operator summaries):

```bash
yarn release:cut --group hosted-cc --assist
```

**Review** `.release-cut/proposal.json`:

- `include` — bullets that ship in this release
- `defer` — internal/chore bullets that stay in `## Unreleased`
- `operatorSummary` — 3–5 lines for What's New UI

Edit the JSON when the heuristic mis-classified items. Use your judgment to consolidate duplicates and rewrite for operators.

## Step 3 — Execute cut

After the proposal looks right:

```bash
yarn release:cut --group hosted-cc --from-proposal .release-cut/proposal.json --execute
```

This bumps workspace versions, finalizes changelog sections, writes `release-notes.json`, and syncs `PROTOCOL_VERSION` when protocol is in the group.

Commit separately:

```text
chore(release): cut command-center-ui@X.Y.Z, gateway@X.Y.Z, …
```

## Step 4 — Ship

| Group       | Next step                                                                       |
| ----------- | ------------------------------------------------------------------------------- |
| `hosted-cc` | Merge PR → `docs-site.yml` deploys `farmslot.io/cc` with What's New             |
| `companion` | `bash apps/companion/scripts/release/release.sh --execute` (after cut)          |
| `npm`       | `yarn packages:publish:check:strict` then manual `yarn npm publish` per package |

## PR rule

Any PR that changes workspace code must add a non-placeholder bullet under that workspace's `## Unreleased`. CI enforces via `yarn quality:changelogs:pr`.

## Stop conditions

- Do **not** `--execute` without reviewing `.release-cut/proposal.json`.
- Do **not** skip changelog bullets on user-facing PRs.
- Release-cut commits are exempt from the PR changelog delta guard.
