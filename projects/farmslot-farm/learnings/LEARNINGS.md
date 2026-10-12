# Farmslot farm learnings

## Bulk retro curation, 2026-10-12

Companion runs `63dc9c3f` and `45988980` ended partial with CI green.

### The leased Companion Metro does not watch files

- Both runs used `apps/companion/scripts/agentic/prepare-profile.sh`, which starts Metro with `CI=1`. Edits stayed invisible after app reloads until an authorized `--clear` restart. Run `63dc9c3f` lost time on a testID missing from the served bundle.
- **Before a device run after an edit, check the served bundle for a string the edit introduced. Plan baselines and guard-removed negative runs with the Metro restarts they need.** This is a stopgap until Companion prepare supports file watching or a worker-callable clear restart.

### A successful press can hit the wrong control

- In `63dc9c3f`, agent-device skipped role-less React Native elements and tapped the nearest hittable ancestor's centre. A palette press landed on `^E`. Adding accessibility roles fixed automation and VoiceOver.
- **Give Companion pressables an `accessibilityRole`, and assert each press's effect.** A successful press alone does not prove the intended control handled it.

### Build fixtures from the producer

- In `63dc9c3f`, a hand-built correlation fixture used `workerPaneId`, while dispatch stores the worker pane in `target.paneId`. The fixture hid that `linkedRunner` never reached a real worker. A test using `parseCapturedAgentPaneTarget` and a live dispatched run on an isolated gateway caught it.
- **Derive test fixtures from the producing function or a live isolated gateway.** Do not build fixtures from the shape the consumer expects.
