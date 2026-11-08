---
id: dev/tooling
title: MetaMask Perps recipe library development
flow: dev
platforms: [ios, mobile]
recipe_checks: [perps.smoke]
recipe_capture: true
runtime_capabilities: [mobile-proof]
runtime_capability_requirements: '[{"capabilityId":"mobile-proof","reason":"Baseline and candidate proof run on this slot''s owned Mobile fixture","mode":"visual"}]'
---

# MetaMask Perps recipe library development

`{{REPO}}` is the recipe library checkout under edit. `{{OWNED_MOBILE_REPO}}` is this slot's own MetaMask Mobile checkout on the execution node, with simulator `{{IOS_SIMULATOR}}` and Metro port `{{WATCHER_PORT}}`. Never use another slot's checkout, simulator or port. This task's `mark` runs its retained published provider and pinned library, never the code you are changing. Set the proof inputs once in the slot shell: `PUBLISHED="$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh published recipe-perps {{REPO}})"` is the published harness, and `RETAINED="$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh retained-library recipe-perps {{REPO}} {{TASK_DIR}})"` is this task's verified retained Perps library. Every run passes `--library perps=` explicitly; never rely on a bundled or operator-configured library.

## Checklist

- [ ] Read `{{REPO}}/README.md`, the brief and the code you will change. Record the acceptance criteria and the prepared source head. Preserve unrelated work.
- [ ] Baseline: acquire `mobile-proof`, then run the closest recipe with `"$PUBLISHED" run <recipe> --library perps="$RETAINED" --adapter mobile --target "{{OWNED_MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/baseline`. A new-behaviour claim must fail at its assertion, not at setup.
- [ ] Make the change in `{{REPO}}` only. Keep recipes parameterized; follow the library README.
- [ ] Changed-file CI [DETERMINISTIC: ci.local_check] - call `{{TASK_DIR}}/mark 4`. The engine runs the frozen repository check and records its receipt. Read the retained log, fix failures and repeat this mark. Do not launch validation yourself.
- [ ] After-fix proof with the candidate library selected explicitly: `"$PUBLISHED" run <recipe> --library perps={{REPO}} --adapter mobile --target "{{OWNED_MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/after-fix`. Record `"$PUBLISHED" --version`, `"$PUBLISHED" --version` and the library source head in the report. Validate the package with `recipe-validate`, inspect screenshots and retain coverage. An unavailable device or dev client is blocked, never a manual-check substitute.
- [ ] Write `artifacts/report.md`, `artifacts/recipe-coverage.md` and `artifacts/pr-description.md` with baseline versus after-fix evidence, both identities and limits. Keep changes local for Gateway publication; do not push or publish. Complete with `{{TASK_DIR}}/mark complete --mark-last` only when the proof contract passes.
