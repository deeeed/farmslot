---
id: dev/tooling
title: MetaMask harness development
flow: dev
platforms: [ios, mobile]
recipe_capture: true
runtime_capabilities: [mobile-proof]
runtime_capability_requirements: '[{"capabilityId":"mobile-proof","reason":"After-fix proof runs the candidate harness against this slot''s owned Mobile fixture","mode":"visual"}]'
---

# MetaMask harness development

`{{REPO}}` is the harness checkout under edit. `{{MOBILE_REPO}}` is this slot's own MetaMask Mobile checkout, with simulator `{{IOS_SIMULATOR}}` and Metro port `{{WATCHER_PORT}}`. Never use another slot's checkout, simulator or port. This task's `mark` runs the retained published harness, never the code you are changing.

## Checklist

- [ ] Read `{{REPO}}/CLAUDE.md`, the brief and the code you will change. Record the acceptance criteria and the prepared source head. Preserve unrelated work.
- [ ] Reproduce or baseline with the published harness `"$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh published harness {{REPO}})"`: acquire `mobile-proof`, then run the closest recipe against `--target "{{MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}}`. Keep the baseline package under `{{TASK_DIR}}/artifacts/baseline/`. A new-behaviour claim must fail at its assertion, not at setup.
- [ ] Make the change in `{{REPO}}` only. Never write into an existing `node_modules` file; dependency changes go through `yarn install --immutable` after editing the lockfile with Yarn.
- [ ] Changed-file CI [DETERMINISTIC: ci.local_check] - call `{{TASK_DIR}}/mark 4`. The engine runs the frozen repository check and records its receipt. Read the retained log, fix failures and repeat this mark. Do not launch validation yourself.
- [ ] After-fix proof with the candidate selected explicitly: run `{{REPO}}/bin/mm-harness run <recipe> --adapter mobile --target "{{MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/after-fix`. Record `{{REPO}}/bin/mm-harness --version` and the source head in the report. Validate the package with `recipe-validate`, inspect screenshots and retain coverage. An unavailable device or dev client is blocked, never a manual-check substitute.
- [ ] Write `artifacts/report.md`, `artifacts/recipe-coverage.md` and `artifacts/pr-description.md` with baseline versus after-fix evidence, the candidate identity and limits. Add a `CHANGELOG.md` entry under Unreleased. Keep changes local for Gateway publication; do not push or publish. Complete with `{{TASK_DIR}}/mark complete --mark-last` only when the proof contract passes.
