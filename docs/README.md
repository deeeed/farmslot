# Farmslot docs index

This folder is the repo-native source of truth for product scope, architecture decisions, implemented history, and stable technical reference.

## Read first

- [Docs governance](DOCS-GOVERNANCE.md) — placement rules and maintenance checklist for this folder.
- [Product PRD](PRD-product.md) — top-level product scope.
- [Roadmap](ROADMAP.md) and [next roadmap](ROADMAP-next.md) — current execution direction.
- [ADR index](adr/README.md) — accepted architecture/product decisions.

## Folder map

- Root `docs/`: canonical PRDs, roadmaps, governance, and implemented history.
- [`adr/`](adr/) — accepted decisions and historical architecture records.
- [`reference/`](reference/) — stable protocol, harness, quality, and technical reference.
- [`plans/`](plans/) — active approved supporting plans that have not been promoted into canonical PRDs/roadmaps.
- [`operations/`](operations/) — public-safe publishing, deployment, quality, and runtime maintenance procedures.
- [`archive/`](archive/) — sanitized historical summaries only; not a scratch dump.
- [`../apps/docs/docs/`](../apps/docs/docs/) — curated Docusaurus website pages; keep public claims consistent with this folder, but prefer concise website explanations over raw planning detail.

## Before adding a doc

Use the checklist in [Docs governance](DOCS-GOVERNANCE.md). If the file is a one-off audit, generated evidence, private release note, or scratch/agent note, keep it outside the public repo instead of adding it here.
