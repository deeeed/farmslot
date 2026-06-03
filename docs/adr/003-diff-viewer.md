# ADR-003: Code Diff & Source View

**Status:** Accepted (revised)
**Date:** 2026-03-26
**Relates to:** [PRD](../PRD-command-center-canonical.md) — Features D4, E3

## Context

Arthur needs to review agent-authored code changes directly in the Command Center. Two complementary views:

1. **Diff review** — "what changed?" — split/unified diff like GitHub's "Files changed"
2. **Code viewer** — "what does the final file look like?" — full source with changed lines highlighted, editor-like navigation

## Decision

**Two components, two libraries — each for its strength.**

### diff-review (diff2html)

GitHub-style diff renderer. Takes unified diff string (`git diff` output), renders split or unified view.

- ~100KB bundle, no workers
- Read-only HTML output, dark theme via CSS overrides
- Component: `ui/src/components/diff-viewer/diff-review.ts`

### code-viewer (Monaco Editor)

Read-only Monaco editor showing the final file with changed lines decorated (green gutter bar + subtle background). Full editor UX: cursor, keyboard navigation, syntax highlighting, minimap.

- ~10MB with workers — acceptable for desktop ops tool
- Monaco decorations API for changed-line highlights
- Component: `ui/src/components/diff-viewer/code-viewer.ts`

### Why both?

- diff2html is best for reviewing changes (additions/deletions side by side)
- Monaco is best for reading the final source in context (navigate, search, understand)
- Different stages of the review workflow need different views

### Review Comments (Future)

For inline review comments (Feature E3):

- On diff-review: custom HTML overlaid on diff2html tables
- On code-viewer: Monaco ViewZone widgets below commented lines

## Consequences

**Positive:**

- Best tool for each job — diff2html for diffs, Monaco for source browsing
- Editor-like navigation when reading final source
- Both share the dark theme

**Negative:**

- ~10MB total bundle (Monaco workers) — acceptable for ops tool
- Two components to maintain
- Monaco requires async worker initialization

## References

- diff2html: https://diff2html.xyz/
- Monaco Editor: https://microsoft.github.io/monaco-editor/
