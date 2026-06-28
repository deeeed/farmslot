# Docusaurus real-run demo media goal

Status: proposed for confirmation  
Use as: `/goal docs/plans/docusaurus-recipe-demo-media-goal.md`  
Supports: `docs/ROADMAP-next.md` real-run capture gaps, Generic Recipe Protocol v1, Command Center, Mobile Companion.

## Goal

Replace Docusaurus mock/fallback demo media with public-safe screenshots and short clips captured from **real Farmslot runs**. Media must be recipe-owned, reproducible, visually inspected, and free of uncleared work project names or private work data. Audiolab, EchoBridge, Companion, and Farmslot self-hosting are allowed targets.

## References

- Farmslot demo issue: https://github.com/deeeed/farmslot/issues/28
- Audiolab demo issue: https://github.com/deeeed/audiolab/issues/414
- Demo stage/capture doc: `docs/plans/docusaurus-demo-stage-fixtures-and-video-generation.md`

## Demo targets to confirm

| Target                                   | Real run/task                                                                                                        | Media                                                                             | Must show                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Command Center parallel watch-and-steer  | Dispatch 2-3 real demo tasks across `audiolab-farm`, `echobridge-farm`, and/or a Farmslot self-worktree              | 16:9 screenshot + 8-15s clip                                                      | multiple live terminals/worker panes, run statuses, monitoring, allowed labels only |
| Human ready/review gate                  | Completed/PR-review workspace for an allowed demo run                                                                | 16:9 screenshot + 8-15s clip if interaction is visible                            | human can accept/continue steering after the agent says work is done                |
| Gateway intelligence from Command Center | Command Center live gateway state on allowed/demo-filtered fleet                                                     | 16:9 screenshot + short clip                                                      | operator opens gateway intelligence and asks about fleet/run status                 |
| Farmslot fixes itself                    | Reversible `DO NOT MERGE` Farmslot debug-panel/demo task, like Audiolab #414                                         | 16:9 screenshot + clip                                                            | dispatch, diff/review workspace, recipe proof, “Farmslot building Farmslot”         |
| Audiolab public demo                     | Use https://github.com/deeeed/audiolab/issues/414: debug banner after sample audio load                              | iOS/Web/Android screenshots + optional clip                                       | recipe opens Import, asserts banner absent, taps Load Sample, asserts exact banner  |
| EchoBridge public demo                   | Equivalent reversible `DO NOT MERGE` EchoBridge task, e.g. debug indicator after sample recording sync/record action | iOS screenshot + optional clip; web/CDP validation if native inspector is limited | real EchoBridge interaction, trace, screenshot artifact                             |
| Recipe evidence/proof view               | Command Center on one completed Audiolab/EchoBridge/Farmslot demo recipe run                                         | 16:9 screenshot + optional clip                                                   | graph/steps, assertions, screenshot/video artifact, provenance                      |
| Companion supervision                    | Real Companion development app with sanitized fixture gateway for the same demo family                               | portrait screenshot + optional clip                                               | active runs, fleet/workers, recipe/evidence/terminal entry points                   |
| Architecture diagram                     | Generated SVG only                                                                                                   | SVG                                                                               | simplified project integration model; not fake demo media                           |

## Required pipeline

1. Define demo tasks first: Audiolab #414, one EchoBridge task, and optionally one Farmslot self-debug task. All are reversible and marked `DO NOT MERGE` where applicable.
2. Dispatch real Farmslot runs. Use allowed projects only; if Command Center global state includes private projects, use a demo-only filter/profile/fixture or crop to allowed panes.
3. Recipes drive interactions and capture proof. Manual screenshots are temporary evidence only, not final media.
4. Recipe artifacts must include `summary.json`, `trace.json`, `artifact-manifest.json`, screenshots, and video when enabled.
5. A docs script may copy inspected real artifacts into `apps/docs/static/img/demos/` and `apps/docs/static/videos/demos/`; it must not generate fake cards.
6. Landing cards must use honest labels: captured screenshot, captured clip, or diagram.

## Public-safety rules

Allowed names: Farmslot, Audiolab, EchoBridge, Companion, generic demo slots/tasks. Forbidden in media/copy: uncleared work project names, private repos, Jira/customer data, tokens, account identifiers, local absolute paths, notifications, private terminals. Prefer re-recording over blurring.

## Acceptance criteria

- No mock SVG demo cards or fallback-image language remain.
- Each asset maps to a real run ID or recipe artifact path plus regeneration command.
- Command Center shows parallel live monitoring/terminals from allowed projects only.
- Audiolab #414 has reproducible cross-platform recipe evidence.
- EchoBridge has Audiolab-style recipe integration and one validated artifact package.
- Companion media is tied to sanitized demo run data.
- `yarn docs:build` passes; Docusaurus is served, opened in browser, and visually verified.

## 2026-06-12 progress

- Command Center watch-and-steer video implemented via `yarn --cwd apps/docs capture:first-video --artifacts-dir .agent/demo-stage/docusaurus-command-center-parallel/output --copy-to-docs`.
- Recipe evidence validation loop implemented via `yarn --cwd apps/docs capture:recipe-evidence --artifacts-dir .agent/demo-stage/docusaurus-recipe-evidence-loop/output --source-dir .agent/demo-stage/docusaurus-command-center-parallel/output --copy-to-docs`.
- Gateway intelligence from Command Center video implemented via `yarn --cwd apps/docs capture:gateway-intelligence --artifacts-dir .agent/demo-stage/docusaurus-gateway-intelligence/output --copy-to-docs`.
- Human ready/review gate screenshot implemented via `yarn --cwd apps/docs capture:human-ready-gate --artifacts-dir .agent/demo-stage/docusaurus-human-ready-gate/output --copy-to-docs`, using a sanitized Command Center ready-gate fixture with visible evidence, quality checks, diff, recipe, and approval actions.
- AudioLab and EchoBridge capture recipes now validate e2e as backing app evidence packages only; they must be surfaced through Command Center/Companion evidence gates, not standalone landing cards. Latest validated outputs:
  - AudioLab: `.agent/demo-stage/docusaurus-audiolab-sample-banner/output/summary.json`, configured simulator `playground-1`, Metro `7365`, real Import screen + sample-load banner proof.
  - EchoBridge: `.agent/demo-stage/docusaurus-echobridge-live-recording/output/summary.json`, configured simulator `echodev-1`, Metro `7600`, real live recorder proof.
- Companion mobile supervision screenshot now uses the real Companion development app on configured simulator `fs-2` with a public-safe fixture gateway: `yarn --cwd apps/docs capture:companion-supervision --artifacts-dir .agent/demo-stage/docusaurus-companion-supervision/output --copy-to-docs`. The capture verifies real websocket requests (`fleet.status`, `run.list`), records simulator video/poster/screenshot, pre-approves permissions, suppresses dev-menu overlays, and does not regenerate store screenshots.
- Remaining required target: final validation of Audiolab/EchoBridge backing evidence surfacing through Command Center or Companion gates. Project-type overview/validation matrix, Companion supervision, Command Center videos, gateway intelligence, and the human ready gate now have docs media paths. Command Center videos require/keep a visible recipe runner HUD in the MP4 and in the Docusaurus hero/demo card rendering.
- 2026-06-12 priority update: gateway intelligence from Command Center and the human ready gate are covered; do not re-add standalone external-app demo cards.
