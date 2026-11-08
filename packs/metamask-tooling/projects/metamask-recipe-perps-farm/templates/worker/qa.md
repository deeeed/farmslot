---
id: qa/tooling
title: MetaMask Perps recipe library PR QA
flow: qa
platforms: [ios, mobile]
recipe_capture: true
runtime_capabilities: [mobile-proof]
runtime_capability_requirements: '[{"capabilityId":"mobile-proof","reason":"Baseline and candidate proof run on this slot''s owned Mobile fixture","mode":"visual"}]'
---

# MetaMask Perps recipe library PR QA

`{{REPO}}` holds the frozen PR head. `{{OWNED_MOBILE_REPO}}` is this slot's own MetaMask Mobile checkout on the execution node, with simulator `{{IOS_SIMULATOR}}` and Metro port `{{WATCHER_PORT}}`. Never use another slot's checkout, simulator or port. This flow is read-only: no product or tooling edits, branch, comment or approval. This task's `mark` runs its retained published provider and pinned library. Set the proof inputs once in the slot shell: `PUBLISHED="$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh published recipe-perps {{REPO}})"` is the published harness, and `RETAINED="$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh retained-library recipe-perps {{REPO}} {{TASK_DIR}})"` is this task's verified retained Perps library. Every run passes `--library perps=` explicitly; never rely on a bundled or operator-configured library.

## Checklist

- [ ] Read the PR, its acceptance criteria and changed files. Freeze the criteria and record the PR head.
- [ ] Repository check [DETERMINISTIC: ci.local_check] - call `{{TASK_DIR}}/mark 2`. The engine runs the frozen repository check on the PR head and records its receipt. Report failures; do not fix them.
- [ ] Acquire `mobile-proof`. Run the baseline with `"$PUBLISHED" run <recipe> --library perps="$RETAINED" --adapter mobile --target "{{OWNED_MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/baseline`, then the same recipe with the candidate selected explicitly: `"$PUBLISHED" run <recipe> --library perps={{REPO}} --adapter mobile --target "{{OWNED_MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/candidate`. Validate both packages and inspect screenshots.
- [ ] Write `artifacts/report.md` and `artifacts/recipe-coverage.md` with a verdict per criterion, `"$PUBLISHED" --version`, `"$PUBLISHED" --version` and the library source head and limits. Complete with `{{TASK_DIR}}/mark complete --mark-last`.
