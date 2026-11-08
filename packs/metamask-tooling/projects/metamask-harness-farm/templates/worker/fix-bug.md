---
id: fix-bug/tooling
title: MetaMask harness bug fix
flow: fix-bug
platforms: [ios, mobile]
recipe_capture: true
runtime_capabilities: [mobile-proof]
runtime_capability_requirements: '[{"capabilityId":"mobile-proof","reason":"Before and after-fix proof runs against this slot''s owned Mobile fixture","mode":"visual"}]'
---

# MetaMask harness bug fix

`{{REPO}}` is the harness checkout under edit. `{{MOBILE_REPO}}` is this slot's own MetaMask Mobile checkout, with simulator `{{IOS_SIMULATOR}}` and Metro port `{{WATCHER_PORT}}`. Never use another slot's checkout, simulator or port. This task's `mark` runs the retained published harness, never the code you are changing.

## Checklist

- [ ] Read `{{REPO}}/CLAUDE.md` and the bug report. Record the expected behaviour, the prepared source head and the owning layer. Preserve unrelated work.
- [ ] Reproduce with the published harness `"$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh published harness {{REPO}})"`: acquire `mobile-proof` and run the failing recipe against `--target "{{MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/before-fix`. The failure must be at the claimed assertion. Classify it before changing code.
- [ ] Fix the root cause in `{{REPO}}` only. Never write into an existing `node_modules` file.
- [ ] Changed-file CI [DETERMINISTIC: ci.local_check] - call `{{TASK_DIR}}/mark 4`. The engine runs the frozen repository check and records its receipt. Read the retained log, fix failures and repeat this mark. Do not launch validation yourself.
- [ ] After-fix proof with the candidate selected explicitly: rerun the same recipe with `{{REPO}}/bin/mm-harness run <recipe> --adapter mobile --target "{{MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/after-fix`. Record `{{REPO}}/bin/mm-harness --version` and the source head. Validate both packages and inspect their screenshots.
- [ ] Write `artifacts/report.md`, `artifacts/recipe-coverage.md` and `artifacts/pr-description.md` with root cause, before and after evidence, the candidate identity and limits. Add a `CHANGELOG.md` entry under Unreleased. Keep changes local for Gateway publication. Complete with `{{TASK_DIR}}/mark complete --mark-last` only when the proof contract passes.
