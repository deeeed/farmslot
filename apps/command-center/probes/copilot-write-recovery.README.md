# Probe: copilot-write-recovery

**Story:** US-009 — Plan `.omx/plans/copilot-write-actions-tightening-2026-05-06.md` Step 9 (AC23 + AC25).
**Probe file:** [`copilot-write-recovery.js`](./copilot-write-recovery.js)
**Status:** Committed, runnable, not throwaway. The probe IS the committed CDP helper for this feature.

## What it asserts

| #   | Assertion                                                                                               | Where verified                                        |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | At least one next-steps block rendered                                                                  | In-page (`document.querySelectorAll`)                 |
| 2   | At least one `<chat-action-card>` rendered                                                              | In-page                                               |
| 3   | Outgoing `chat.confirmAction` WS frame: `Object.keys(params).sort().join(',') === 'actionId,sessionId'` | In-page (WebSocket.send patch)                        |
| 4   | While card A `_pending=true`, card B has no `disabled` attribute                                        | In-page                                               |
| 5   | Four `[chat-actions]` telemetry log-line patterns appear in `/tmp/farmslot-dev.log`                     | **Out-of-band** — runner shell must grep the log file |

The probe runs in-page, so it cannot read `/tmp/farmslot-dev.log` itself (browser sandbox). For assertion 5, the probe RETURNS the four required patterns; the runner verifies them out-of-band.

## How to run

### 1. Pre-flight (services up)

```bash
# Dev server (gateway:7777 + vite:5174). Capture logs because assertion 5 needs them.
cd apps/command-center && yarn dev > /tmp/farmslot-dev.log 2>&1 &

# Wait for gateway health
until curl -sf http://localhost:7777/health > /dev/null; do sleep 1; done

# Chrome with CDP on the default Farmslot port (9323)
bash apps/command-center/scripts/debug-chrome.sh
```

### 2. Pick a route hash

The probe is route-agnostic — it locates `<chat-panel>` directly and synthetically injects the cards. Recommended:

- `dev/chat` — fastest, fully isolated (mock messages, no LLM round-trip required). **Recommended for CI.**
- `fleet`, `runs`, or `run/<id>` — production shells. The probe will click the chat toolbar button to mount the panel.

```bash
# Easiest: dev harness
node apps/command-center/scripts/cdp.mjs eval dev/chat --file apps/command-center/probes/copilot-write-recovery.js

# Production shell (chat panel toggled via toolbar):
node apps/command-center/scripts/cdp.mjs eval fleet --file apps/command-center/probes/copilot-write-recovery.js
```

### 3. Verify telemetry (assertion 5)

```bash
for p in \
  '\[chat-actions\] register actionId=' \
  '\[chat-actions\] confirm actionId=.* ok=true' \
  '\[chat-actions\] reject actionId=' \
  '\[chat-actions\] server-direct-issue source=propose_run_recovery'
do
  count=$(grep -c -E "$p" /tmp/farmslot-dev.log 2>/dev/null || echo 0)
  echo "$p  →  $count line(s)"
done
```

A green pass for assertion 5 requires at least 1 hit on each of the four patterns. The probe itself only contributes the `reject` line (synthetic actionIds are unknown to the gateway registry → reject reason `unknown`); the other three are produced by real flows (see "Limitations" below).

## Driving strategy

The probe ships with **Option C** (UI-bypass synthetic seeding). Three options were considered:

- **Option A (real flow)** — call `chat.send` with `intent: 'diagnostic-readonly'` against a live failed run that triggers `propose_run_recovery` and lane 3a. **Not used by default** because:
  - Requires a failed run with `prepare`/`run` step in `{failed,error}` AND `failureCategory ∈ {flake,infra,env-drift,timeout}` AND a bound slot.
  - Costs LLM tokens.
  - Flaky in CI (model may not echo `<actions>` consistently; lane 3a fixes that, but tool-trace surface depends on tool execution succeeding).
- **Option B (mock seed via debug RPC)** — would call e.g. `chat.testIssueActions`. **Not available**: the gateway exposes no test/debug seam to issue actions. See "Limitations" below.
- **Option C (UI-bypass synthetic)** — the probe injects 2 synthetic `ChatSuggestedAction` entries into the live `<chat-panel>`'s `messages` reactive state. The real `<chat-message>` renderer mounts real `<chat-action-card>` siblings. The real click handler dispatches a real `chat.confirmAction` over the real WebSocket; the gateway responds with a real reject (synthetic actionId → unknown). **Selected** — fast, deterministic, exercises the entire UI + WS stack except for the gateway-side registry registration.

## Limitations

1. **Assertion 1 selector divergence.** The plan calls for `document.querySelectorAll('next-steps-block').length >= 1`. The codebase has **no `<next-steps-block>` custom element** — next steps are rendered inline inside `<chat-message>` via the `.cm-next-steps` class. The probe checks both selectors; today the class-selector path is the one that passes. If a future refactor extracts a `<next-steps-block>` element, the custom-element path will start passing automatically.

2. **Telemetry coverage gap.** Of the four required `[chat-actions]` log patterns, the probe only emits one (`reject`, via the unknown-actionId reject). The other three (`register`, `confirm ok=true`, `server-direct-issue`) require real flows that the probe cannot drive without:
   - A test/debug RPC seam (Option B) — does **not exist** in `chat-actions.ts`. **This is a missing test seam.** Options to close the gap (left for follow-up, NOT in US-009 scope):
     - Add a dev-only `chat.devIssueActions(sessionId, actions)` RPC, gated on `NODE_ENV !== 'production'`.
     - Have the probe invoke a real `chat.send` with `intent: 'diagnostic-readonly'` and a curated mock failed run; cost ~$0.01–0.05 per probe run + 5–15 s latency.
   - For now, the runner verifies the missing three patterns by inspecting historical log lines from prior unit-test or live-flow runs. The probe RETURNS the patterns so the runner can run `grep -c -E '<pattern>' /tmp/farmslot-dev.log` for each.

3. **Probe leaves a ghost message.** The probe cleans up (`chatPanel.messages.filter(...)` to drop the synthetic message) on success; on early `fail()` paths it does not. This is intentional — leaving the message visible aids debugging when the probe fails. Reload the page to clear.

4. **Live ws restoration.** The probe patches `WebSocket.prototype.send` to capture the `chat.confirmAction` frame. It restores the original `send` in the `finally`-equivalent path, but only after the WS round-trip completes (cap 5 s). If the gateway is down or the round-trip never resolves, the prototype stays patched until the next page load. Reload to recover.

## Return contract

```ts
{
  ok: boolean,                   // false if any of A1–A4 fails or a setup error occurred
  strategy: 'option-c-ui-bypass',
  sessionId: string,             // the session under which chat.confirmAction was sent
  assertions: {
    a1_nextStepsRendered: { ok, count, selector },
    a2_actionCardsRendered: { ok, count, ourCards },
    a3_confirmFrameKeysExact: { ok, observed, expected, frame },
    a4_perCardPendingIsolated: { ok, cardA_pending, cardB_disabled },
    a5_telemetryPatternsForRunnerToCheck: { ok: 'deferred-to-runner', note, patterns: string[] },
  },
  notes: string[],
  error: string | null,
}
```

`ok === true` means A1–A4 all passed. A5 is always `'deferred-to-runner'` and the runner shell verifies it separately.
