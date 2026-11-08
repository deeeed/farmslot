---
id: qa/tooling
title: MetaMask harness PR QA
flow: qa
platforms: [ios, mobile]
recipe_capture: true
runtime_capabilities: [mobile-proof]
runtime_capability_requirements: '[{"capabilityId":"mobile-proof","reason":"PR QA proves the candidate harness on this slot''s owned Mobile fixture","mode":"visual"}]'
---

# MetaMask harness PR QA

`{{REPO}}` holds the frozen PR head of the harness. `{{MOBILE_REPO}}` is this slot's own MetaMask Mobile checkout, with simulator `{{IOS_SIMULATOR}}` and Metro port `{{WATCHER_PORT}}`. This flow is read-only: no product or tooling edits, branch, comment or approval.

## Checklist

- [ ] Read the PR, its acceptance criteria and changed files. Freeze the criteria and record the PR head.
- [ ] Repository check [DETERMINISTIC: ci.local_check] - call `{{TASK_DIR}}/mark 2`. The engine runs the frozen repository check on the PR head and records its receipt. Report failures; do not fix them.
- [ ] Acquire `mobile-proof`. Run the baseline with the published harness `"$(bash {{NODE_SUPPORT_DIR}}/projects/metamask-harness-farm/scripts/tooling.sh published harness {{REPO}})"`, then the same recipe with the candidate selected explicitly: `{{REPO}}/bin/mm-harness run <recipe> --adapter mobile --target "{{MOBILE_REPO}}" --device "{{IOS_SIMULATOR}}" --watcher-port {{WATCHER_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/candidate`. Validate both packages and inspect screenshots.
- [ ] Write `artifacts/report.md` and `artifacts/recipe-coverage.md` with a verdict per criterion, both harness identities and limits. Complete with `{{TASK_DIR}}/mark complete --mark-last`.
