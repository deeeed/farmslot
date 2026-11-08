---
id: fix-bug/tooling
title: MetaMask Perps recipe library bug fix
flow: fix-bug
platforms: [ios, mobile]
recipe_checks: [perps.smoke]
recipe_capture: true
runtime_capabilities: [mobile-proof]
runtime_capability_requirements: '[{"capabilityId":"mobile-proof","reason":"Baseline and candidate proof run on this slot''s owned Mobile fixture","mode":"visual"}]'
---

# MetaMask Perps recipe library bug fix

`{{REPO}}` is the recipe library checkout under edit. `{{OWNED_MOBILE_REPO}}` is this slot's own MetaMask Mobile checkout on the execution node, with simulator `{{IOS_SIMULATOR}}` and Metro port `{{WATCHER_PORT}}`. Never use another slot's checkout, simulator or port. This task's `mark` runs its retained published provider and pinned library, never the code you are changing. Set the proof inputs once in the slot shell: `PUBLISHED="$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh published recipe-perps {{REPO}})"` is the published harness, and `RETAINED="$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh retained-library recipe-perps {{REPO}} {{TASK_DIR}})"` is this task's verified retained Perps library. Every run passes `--library perps=` explicitly; never rely on a bundled or operator-configured library.

## Checklist

- [ ] Read `{{REPO}}/README.md` and the bug report. Record the expected behaviour, the prepared source head and the owning layer. Preserve unrelated work.
- [ ] Reproduce: acquire `mobile-proof` and run the failing recipe with `"$PUBLISHED" run <recipe> --library perps="$RETAINED" --adapter mobile --target "{{OWNED_MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/before-fix`. The failure must be at the claimed assertion. Classify it before changing code.
- [ ] Fix the root cause in `{{REPO}}` only. Keep recipes parameterized; follow the library README.
- [ ] Changed-file CI [DETERMINISTIC: ci.local_check] - call `{{TASK_DIR}}/mark 4`. The engine runs the frozen repository check and records its receipt. Read the retained log, fix failures and repeat this mark. Do not launch validation yourself.
- [ ] After-fix proof with the candidate library selected explicitly: rerun the same recipe with `"$PUBLISHED" run <recipe> --library perps={{REPO}} --adapter mobile --target "{{OWNED_MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/after-fix`. Record `"$PUBLISHED" --version`, `"$PUBLISHED" --version` and the library source head. Validate both packages and inspect their screenshots.
- [ ] Write `artifacts/report.md`, `artifacts/recipe-coverage.md` and `artifacts/pr-description.md` with root cause, before and after evidence, both identities and limits. Keep changes local for Gateway publication. Complete with `{{TASK_DIR}}/mark complete --mark-last` only when the proof contract passes.
