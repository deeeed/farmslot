# First real-run Docusaurus video goal

Status: proposed first slice  
Use as: `/goal docs/plans/docusaurus-first-real-run-video-goal.md`  
Parent plan: `docs/plans/docusaurus-recipe-demo-media-goal.md`

## Goal

Prove the end-to-end workflow for **one** public-safe Docusaurus demo video before creating the full media set. The video must be produced by a checked-in recipe/capture recipe so it can be re-run when the UI changes. The first video is Command Center monitoring real Farmslot work in parallel.

## First video target

**Title:** Command Center parallel watch-and-steer  
**Output:** one 8-15s MP4 + one extracted PNG poster frame  
**Destination:** `apps/docs/static/videos/demos/command-center-parallel-watch.mp4` and `apps/docs/static/img/demos/command-center-parallel-watch.png`  
**Must show:** multiple live terminal/worker panes, run statuses, monitoring, and allowed project labels only.  
**Allowed projects:** Audiolab, EchoBridge, Farmslot self-demo.  
**Forbidden:** private repos, private paths, tokens, notifications, work terminals.

## References

- Farmslot demo issue: https://github.com/deeeed/farmslot/issues/28
- Audiolab demo issue: https://github.com/deeeed/audiolab/issues/414
- Demo stage/capture doc: `docs/plans/docusaurus-demo-stage-fixtures-and-video-generation.md`

## Demo run setup

Use real dispatched work, not dev harness screenshots.

Preferred run mix:

1. Audiolab: issue #414 or a tiny `DO NOT MERGE` demo branch/task.
2. EchoBridge: equivalent tiny reversible demo task.
3. Optional Farmslot self-demo: reversible debug-panel task if safe and quick.

If all three are too much for the spike, run two allowed tasks first. The video succeeds if Command Center visibly supervises parallel real runs from allowed targets.

## Mandatory recipe/capture requirement

This video must be reproducible from a recipe, not from ad hoc manual screen recording.

1. Add or identify a checked-in demo capture recipe that:
   - creates or selects the demo run family,
   - opens Command Center to the intended monitoring view,
   - applies the public-safe allowed-project filter/profile,
   - verifies multiple allowed runs/terminals are visible,
   - records the 8-15s proof window,
   - extracts/registers the poster frame,
   - writes `summary.json`, `trace.json`, and `artifact-manifest.json`.
2. The docs media script may only copy recipe-produced artifacts into Docusaurus static paths.
3. The recipe command must be documented as the single regeneration path for this media.
4. If recipe video capture is missing, the goal is not complete. Document the blocker and implement the smallest reusable recipe capture helper first.
5. Do not generate fake video/poster assets.

## Implementation tasks

1. Confirm clean public-safe Command Center view strategy: filter/profile/crop to allowed demo runs only.
2. Create/update the checked-in recipe that dispatches/selects allowed demo runs and captures the video/poster.
3. Run the recipe and verify its trace/manifest references the produced MP4 and poster.
4. Copy only recipe-produced artifacts into Docusaurus static assets.
5. Inspect video + poster visually for clarity and public safety.
6. Add only this first video/poster to Docusaurus landing page.
7. Build, serve, open, and visually verify Docusaurus.
8. Document the exact recipe command as the regeneration path.

## Acceptance criteria

- One real-run MP4 and poster frame are present in docs static assets.
- The MP4/poster were produced by the checked-in recipe, with `summary.json`, `trace.json`, and `artifact-manifest.json`.
- The media shows allowed demo runs only and no private work project labels.
- The Docusaurus landing page renders the video/poster locally.
- The exact recipe command can regenerate the media after UI changes.
- `yarn docs:build` passes.
- Do not expand to Audiolab/EchoBridge/Companion landing media until this first video succeeds.

## 2026-06-12 first-slice result

Implemented the first slice as a recipe-owned, steering-visible video:

```bash
yarn --cwd apps/docs capture:first-video \
  --artifacts-dir .agent/demo-stage/docusaurus-command-center-parallel/output \
  --copy-to-docs
```

Final docs assets:

- `apps/docs/static/videos/demos/command-center-parallel-watch.mp4`
- `apps/docs/static/img/demos/command-center-parallel-watch.png`

Local recipe evidence:

- `.agent/demo-stage/docusaurus-command-center-parallel/output/summary.json`
- `.agent/demo-stage/docusaurus-command-center-parallel/output/trace.json`
- `.agent/demo-stage/docusaurus-command-center-parallel/output/artifact-manifest.json`
- `.agent/demo-stage/docusaurus-command-center-parallel/output/screenshots/command-center-parallel-watch.png`
- `.agent/demo-stage/docusaurus-command-center-parallel/output/screenshots/command-center-parallel-watch-after-steer.png`

The MP4 is not static: recording starts first, then the recipe sends safe visible terminal input into the demo panes and an operator prompt into the Haiku worker pane.

Validation performed:

- `yarn --cwd apps/command-center typecheck`
- `yarn docs:build`
- Served Docusaurus at `http://127.0.0.1:3000/`
- Opened in the existing debug Chrome/CDP session and verified two video elements load `command-center-parallel-watch.mp4` with poster `command-center-parallel-watch.png`.
- Visually inspected hero and demo-card screenshots from the served site.
