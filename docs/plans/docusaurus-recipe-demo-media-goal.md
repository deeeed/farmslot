# Docusaurus real-run demo media goal

Status: proposed for confirmation  
Use as: `/goal docs/plans/docusaurus-recipe-demo-media-goal.md`  
Supports: `docs/ROADMAP-next.md` real-run capture gaps, Generic Recipe Protocol v1, Command Center, Mobile Companion.

## Goal

Replace Docusaurus mock/fallback demo media with public-safe screenshots and short clips captured from **real Farmslot runs**. Media must be recipe-owned, reproducible, visually inspected, and free of `metamask-*` or private work data. Audiolab, EchoBridge, Companion, and Farmslot self-hosting are allowed targets.

## Demo targets to confirm

| Target                                  | Real run/task                                                                                                        | Media                                                                             | Must show                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Command Center parallel watch-and-steer | Dispatch 2-3 real demo tasks across `audiolab-farm`, `echobridge-farm`, and/or a Farmslot self-worktree              | 16:9 screenshot + 8-15s clip                                                      | multiple live terminals/worker panes, run statuses, monitoring, allowed labels only |
| Farmslot fixes itself                   | Reversible `DO NOT MERGE` Farmslot debug-panel/demo task, like Audiolab #414                                         | 16:9 screenshot + clip                                                            | dispatch, diff/review workspace, recipe proof, “Farmslot building Farmslot”         |
| Audiolab public demo                    | Use https://github.com/deeeed/audiolab/issues/414: debug banner after sample audio load                              | iOS/Web/Android screenshots + optional clip                                       | recipe opens Import, asserts banner absent, taps Load Sample, asserts exact banner  |
| EchoBridge public demo                  | Equivalent reversible `DO NOT MERGE` EchoBridge task, e.g. debug indicator after sample recording sync/record action | iOS screenshot + optional clip; web/CDP validation if native inspector is limited | real EchoBridge interaction, trace, screenshot artifact                             |
| Recipe evidence/proof view              | Command Center on one completed Audiolab/EchoBridge/Farmslot demo recipe run                                         | 16:9 screenshot + optional clip                                                   | graph/steps, assertions, screenshot/video artifact, provenance                      |
| Companion supervision                   | Sanitized Companion store-screenshot/fixture recipe mode for the same demo family                                    | portrait screenshot + optional clip                                               | active runs, fleet/workers, recipe/evidence/terminal entry points                   |
| Architecture diagram                    | Generated SVG only                                                                                                   | SVG                                                                               | simplified project integration model; not fake demo media                           |

## Required pipeline

1. Define demo tasks first: Audiolab #414, one EchoBridge task, and optionally one Farmslot self-debug task. All are reversible and marked `DO NOT MERGE` where applicable.
2. Dispatch real Farmslot runs. Use allowed projects only; if Command Center global state includes private projects, use a demo-only filter/profile/fixture or crop to allowed panes.
3. Recipes drive interactions and capture proof. Manual screenshots are temporary evidence only, not final media.
4. Recipe artifacts must include `summary.json`, `trace.json`, `artifact-manifest.json`, screenshots, and video when enabled.
5. A docs script may copy inspected real artifacts into `apps/docs/static/img/demos/` and `apps/docs/static/videos/demos/`; it must not generate fake cards.
6. Landing cards must use honest labels: captured screenshot, captured clip, or diagram.

## Public-safety rules

Allowed names: Farmslot, Audiolab, EchoBridge, Companion, generic demo slots/tasks. Forbidden in media/copy: `metamask-*`, private repos, Jira/customer data, tokens, wallet addresses, local absolute paths, notifications, private terminals. Prefer re-recording over blurring.

## Acceptance criteria

- No mock SVG demo cards or fallback-image language remain.
- Each asset maps to a real run ID or recipe artifact path plus regeneration command.
- Command Center shows parallel live monitoring/terminals from allowed projects only.
- Audiolab #414 has reproducible cross-platform recipe evidence.
- EchoBridge has Audiolab-style recipe integration and one validated artifact package.
- Companion media is tied to sanitized demo run data.
- `yarn docs:build` passes; Docusaurus is served, opened in browser, and visually verified.
