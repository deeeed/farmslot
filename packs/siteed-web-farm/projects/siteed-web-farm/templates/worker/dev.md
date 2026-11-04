---
id: dev/default
title: siteed-web development
flow: dev
platforms: [cli, web]
recipe_checks: [smoke]
recipe_actions: [ui.navigate, ui.wait_for, ui.press, ui.screenshot, app.status]
recipe_capture: true
recipe_hud: true
runtime_capabilities: [web-browser]
runtime_capability_requirements: '[{"capabilityId":"web-browser","reason":"Website acceptance proof needs the owned browser and prepared sandbox","mode":"visual"}]'
---

# siteed-web development

Use the prepared checkout, runtime and assigned ports. Preparation supplies the recipe provider and dependencies; do not install a different harness or launch another browser. The sandbox URL is `http://127.0.0.1:{{WATCHER_PORT}}/`. Its server stays up for Arthur after proof; Gateway closeout owns browser leases.

## Checklist

- [ ] Read the brief and changed pages. Record acceptance criteria and the prepared source head. Preserve unrelated work; never deploy.
- [ ] Discover actions through `farmslot recipe actions --project siteed-web-farm --target "{{REPO}}" --raw --json`. Use catalog actions and existing recipes before adding task-specific nodes.
- [ ] Write `{{TASK_DIR}}/artifacts/recipe.json` with one root `proofTargets` entry per acceptance criterion. Give each executable AC node `proves` and a clear intent. For visual claims, wait for the specific rendered state and take a screenshot there. Read the generated TASK's Recipe proof + acceptance review contract; use its task binding so the engine writes verdicts.
- [ ] Plan/proof-check the recipe, then run its baseline before implementation. A new-behavior claim must fail at its AC assertion, not setup. Preserve the baseline result.
- [ ] Make the accepted change.
- [ ] Changed-file CI [DETERMINISTIC: ci.local_check] - call `{{TASK_DIR}}/mark 6`. The engine runs the frozen command and records its receipt. Read the retained failure log, fix failures and repeat this mark. Do not select or launch tests, builds, lint or validation scripts yourself.
- [ ] Run the task recipe through the hosted command with `--watcher-port {{WATCHER_PORT}} --cdp-port {{METRO_PORT}} --record-video=full-run --artifacts-dir <fresh-task-relative-attempt-directory>`. Validate its artifact package, inspect screenshots and video, and retain recipe coverage. An unavailable surface is blocked, never a manual-check substitute.
- [ ] Write `artifacts/report.md`, `artifacts/recipe-coverage.md` and `artifacts/pr-description.md` with the sandbox URL, evidence and limits. Keep changes local for Gateway publication; do not push, create a PR or deploy from the worker. Complete with `{{TASK_DIR}}/mark complete --mark-last` only when the proof contract passes.
