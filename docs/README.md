# Farmslot docs index

This folder holds product scope, architecture decisions, historical snapshots, and stable technical reference. Use approved Farmslot roadmap/backlog items or public-safe GitHub issues for current plans, and workspace changelogs plus merged PRs for shipped work.

## Read first

- [Docs governance](DOCS-GOVERNANCE.md) — placement rules and maintenance checklist for this folder.
- [Product PRD](PRD-product.md) — top-level product scope.
- [Roadmap](ROADMAP.md), [next roadmap](ROADMAP-next.md), and [implemented history](IMPLEMENTED-HISTORY.md) — frozen historical snapshots, not current planning records.
- [ADR index](adr/README.md) — accepted architecture/product decisions.
- [ADR implementation status](reference/adr-implementation-status.md) — what is shipped vs still open per current ADR.

## Folder map

- Root `docs/`: canonical PRDs and governance, with retained roadmap/history snapshots.
- [`adr/`](adr/) — accepted decisions and historical architecture records.
- [`reference/`](reference/) — stable protocol, harness, quality, and technical reference.
- [`plans/`](plans/) — approved supporting plans linked to a PRD or current planning item.
- [`operations/`](operations/) — public-safe publishing, deployment, quality, and runtime maintenance procedures.
- [`archive/`](archive/) — sanitized historical summaries only; not a scratch dump.
- [`../apps/docs/docs/`](../apps/docs/docs/) — curated Docusaurus website pages; keep public claims consistent with this folder, but prefer concise website explanations over raw planning detail.

## Before adding a doc

Use the checklist in [Docs governance](DOCS-GOVERNANCE.md). If the file is a one-off audit, generated evidence, private release note, or scratch/agent note, keep it outside the public repo instead of adding it here.
