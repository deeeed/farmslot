# Farmslot Documentation Governance

This file defines what belongs in `docs/` and how to keep it clean. Treat it as the maintenance contract for repository documentation.

## Authority Order

When documents disagree, use this order:

1. **ADRs and retained history** — `docs/adr/*.md` and sanitized archive files record accepted decisions and shipped history.
2. **Product PRD hierarchy** — `PRD-product.md` plus the canonical chunk PRDs define current product scope.
3. **Roadmaps** — `ROADMAP.md` is the high-level roadmap; `ROADMAP-next.md` is the near-term execution surface.
4. **Derived summaries** — `IMPLEMENTED-HISTORY.md` summarizes shipped work but is not raw evidence.
5. **Supporting reference/plan/operation docs** — useful details, not product authority unless linked from the canonical docs above.

## Top-Level Allowlist

Only high-level, operator-facing documents should live directly under `docs/`:

- `README.md`
- `DOCS-GOVERNANCE.md`
- `PRD-product.md`
- `PRD-*-canonical.md`
- `ROADMAP.md`
- `ROADMAP-next.md`
- `IMPLEMENTED-HISTORY.md`

Do **not** add audits, one-off goals, scratch specs, implementation notes, generated dumps, benchmark transcripts, or app-store/release checklists to the root of `docs/`.

## Folder Placement Rules

Use these folders for everything else:

| Folder             | Use for                                                                        | Rules                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/adr/`        | Architecture/product decisions                                                 | ADRs are historical records. Do not rewrite old ADRs just to match current naming; add a new ADR or update governance/roadmaps around them.                                                                                       |
| `docs/reference/`  | Stable technical reference, protocols, harness details, quality policies       | Lowercase kebab-case filenames. Keep evergreen; avoid one-run evidence.                                                                                                                                                           |
| `docs/plans/`      | Active approved supporting plans not yet promoted into canonical PRDs/roadmaps | Must state status/scope at the top and link back to the canonical PRD or roadmap it supports. Delete or promote stale/shipped plans instead of retaining raw implementation history.                                              |
| `docs/operations/` | Publishing, deployment, Sonar/quality, local operator procedures               | Must be actionable and public-safe. No private tokens, account-specific credentials, or local machine assumptions.                                                                                                                |
| `docs/examples/`   | Small public examples                                                          | Must be generic and reproducible. No private project names or real tickets.                                                                                                                                                       |
| `docs/archive/`    | Sanitized public-safe historical summaries                                     | Archive is not a junk drawer. Do not put private planning dumps here; remove them from the public tree instead.                                                                                                                   |
| `apps/docs/docs/`  | Public website content                                                         | Use for reader-facing website pages. Website pages may be more concise than repo-native canonical docs, but public claims must stay consistent with the PRDs, ADRs, and reference docs. Do not bulk-copy root docs into the site. |

## Naming Rules

- Root canonical docs may keep uppercase product naming (`PRD-*.md`, `ROADMAP*.md`).
- Subfolder docs use lowercase kebab-case (`recipe-protocol-v1.md`, not `RECIPE-PROTOCOL-V1.md`).
- Avoid date-stamped filenames. Migration audits, one-off readiness scans, and agent review transcripts should live outside the public repo; summarize durable outcomes in canonical docs such as `IMPLEMENTED-HISTORY.md`, operations docs, or relevant PRDs instead.

## New-Doc Checklist

Before adding a new file under `docs/`, answer these questions in the PR/commit message or the document header:

1. Is this canonical product truth, stable reference, an approved plan, operations guidance, example material, or sanitized history?
2. Why is a new file needed instead of updating an existing canonical doc?
3. Which canonical PRD/roadmap/ADR does it support?
4. Is it public-safe? Check for private tickets, internal org names, personal accounts, local hostnames, screenshots, tokens, and generated evidence.
5. Does it have a clear owner/lifecycle: keep, promote, or delete?

If the answer is “scratch”, “temporary”, “agent notes”, “one-off audit”, or “private release checklist”, do **not** put it in `docs/`. Use ignored local notes, task artifacts, or an external private archive.

## Current Canonical Set

- [PRD-product.md](PRD-product.md)
- [PRD-core-farmslot-canonical.md](PRD-core-farmslot-canonical.md)
- [PRD-command-center-canonical.md](PRD-command-center-canonical.md)
- [PRD-automation-intelligence-canonical.md](PRD-automation-intelligence-canonical.md)
- [PRD-mobile-companion-canonical.md](PRD-mobile-companion-canonical.md)
- [PRD-runner-execution-canonical.md](PRD-runner-execution-canonical.md)
- [ROADMAP.md](ROADMAP.md)
- [ROADMAP-next.md](ROADMAP-next.md)
- [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md)

## Maintenance Cadence

Before public release or major PRs touching docs:

1. Run `find docs -maxdepth 1 -type f` and verify every root file is on the allowlist above.
2. Run a private-name scan across `docs` and `apps/docs/docs` using the current public-readiness patterns, then justify or remove every match.
3. For Docusaurus changes, verify sidebar coverage: every human-facing page should be in `apps/docs/sidebars.js`; generated/raw references may stay unlisted only when linked from a curated page.
4. Run `yarn docs:build` after link or website changes.
5. Run tracked-tree secret scanning before publishing.
6. Delete stale plans instead of indefinitely archiving them.
