# scroll-to-visible conformance

Two layers exercise the `ui.scroll_to` contract.

## Provider-neutral suite

`test/scroll-to-visible.test.ts` runs recipes through `createRecipeRunner` and
`createStandardUiAdapters` against a fake native-style provider: one scroll surface in
window coordinates, one device lock, and a retained session:

| Case                                         | Expectation                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Target already in the safe viewport          | `alreadyVisible: true`, no `scrollTo` call, settlement `skipped`          |
| Far target                                   | one absolute `scrollTo`, `before`/`after` bounds, settled, `finalVisible` |
| Flattened Text target + measurable anchor    | passes via `visibility_anchor_test_id`; target still asserted present     |
| Anchor present, target missing               | `SCROLL_TARGET_MISSING`; the anchor never stands in for the target        |
| Row under the HUD                            | `safeViewport` excludes the HUD; the row ends above it                    |
| Layout that never stops changing             | `SCROLL_SETTLEMENT_TIMEOUT` with the last geometry                        |
| Layout that shifts once, then settles        | passes with the settled bounds                                            |
| Three nodes on one retained session          | same `sessionId`, one connection, no self-lock                            |
| Provider that keeps its lock                 | next node fails `SCROLL_SESSION_CONFLICT`                                 |
| Surface missing / box-less target, no anchor | `SCROLL_SURFACE_MISSING` / `SCROLL_TARGET_NOT_MEASURABLE`                 |
| Content too short to reach the target        | `SCROLL_TARGET_NOT_VISIBLE`; `verify_visible: false` records it instead   |

Every failure is `cause_class: harness` with `error_code` and the observed geometry in
`error_details`. Absolute versus relative `ui.scroll` movement is covered in
`test/recipe-harness.test.ts`.

## Real browser page

`page.html` is the same scenario set on a real DOM: a `scroll-surface` container, a far
`history-proof` row, a `display: contents` `flat-text` span inside the measurable
`flat-anchor` row, and a `jitter-target` below a block that grows on every animation
frame when the URL has `?jitter=1`. Serve it from the Command Center Vite origin so the
CDP runner can attach to it:

```
<ui_url>/@fs<repo>/packages/recipe-harness/test/fixtures/scroll-to-visible/page.html
```
