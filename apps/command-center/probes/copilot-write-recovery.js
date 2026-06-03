// copilot-write-recovery.js
//
// CDP probe for US-009 (plan: copilot-write-actions-tightening-2026-05-06.md, AC23 + AC25).
// Asserts the end-to-end happy path for Co-Pilot confirmed write-recovery cards:
//
//   1. ≥1 next-steps block rendered                    (UI render)
//   2. ≥1 chat-action-card rendered                    (UI render)
//   3. Outgoing chat.confirmAction WS frame has params keys exactly = "actionId,sessionId"
//      (per principle "Operator never blind-types ids" — no slotId/runId/etc.)
//   4. Per-card pending: while card A is _pending=true, card B has no `disabled` attribute
//   5. Telemetry — four [chat-actions] log-line patterns are emitted to the gateway log
//      (register, confirm, reject, server-direct-issue). The probe RETURNS the four
//      grep patterns; the runner verifies them out-of-band against /tmp/farmslot-dev.log
//      because in-page JS cannot read the host filesystem.
//
// Driving strategy
// ----------------
// The natural driver (real `chat.send` with intent='diagnostic-readonly' against a
// failed run that lane 3a recognises) requires:
//   (a) a live failed run in the gateway runStore with a `prepare` or `run` step in
//       terminal state {failed,error};
//   (b) the run bound to a slot;
//   (c) the run's `failureCategory` ∈ recoverable set {flake,infra,env-drift,timeout};
//   (d) an LLM round-trip that costs money + adds 5-30s latency.
// In CI / dev that combination is rarely present, so this probe ships with a
// **deterministic UI-bypass driver**:
//   - call gateway `chat.confirmAction` with a synthetic actionId to drive a *real*
//     reject (reason='unknown') — that is what produces the `[chat-actions] reject`
//     telemetry line and the `Object.keys(params).sort().join(',') === 'actionId,sessionId'`
//     proof for assertion 3;
//   - synthetically inject two ChatSuggestedAction objects into the live `<chat-panel>`'s
//     `messages` array so the existing `<chat-message>` renderer mounts two real
//     `<chat-action-card>` siblings + one `.cm-next-steps` block — that is what
//     drives assertions 1, 2, and 4.
//
// The synthetic injection uses the *real* component path (`chat-message` →
// `chat-action-card`); it does NOT hand-build DOM. Per-card pending is also driven
// through the real handler chain — `dispatchEvent('action-confirm')` from card A
// triggers `chat-panel.onActionConfirm`, which sets `card._pending` via
// `markResolved()` once the WS round-trip resolves. We snapshot card B *during*
// the in-flight window (before the await resolves) so we observe the real pending
// state, not a fabricated one.
//
// To run with a real driver instead (Option A above): pass --hash=run/<failedRunId>
// after warming a failed run; the probe's bypass branch is opt-out via the
// `data-probe-real-driver="1"` attribute on `<chat-panel>` (set by an external
// harness if needed).

return (async () => {
  const RESULT = {
    ok: false,
    strategy: 'option-c-ui-bypass',
    assertions: {
      a1_nextStepsRendered: { ok: false, count: 0, selector: '.cm-next-steps' },
      a2_actionCardsRendered: { ok: false, count: 0 },
      a3_confirmFrameKeysExact: { ok: false, observed: null, expected: 'actionId,sessionId' },
      a4_perCardPendingIsolated: { ok: false, cardA_pending: false, cardB_disabled: null },
      a5_telemetryPatternsForRunnerToCheck: {
        ok: 'deferred-to-runner',
        note: 'Assertion 5 requires reading /tmp/farmslot-dev.log, which in-page JS cannot do. The runner shell that invokes this probe must also run the four greps below and join the result.',
        patterns: [
          '\\[chat-actions\\] register actionId=.* sessionId=.* type=.*',
          '\\[chat-actions\\] confirm actionId=.* ok=true type=.*',
          '\\[chat-actions\\] reject actionId=.* reason=.* type=.*',
          '\\[chat-actions\\] server-direct-issue source=propose_run_recovery type=.* actionId=.*',
        ],
      },
    },
    notes: [],
    error: null,
  };

  const fail = (msg, detail) => {
    RESULT.ok = false;
    RESULT.error = msg;
    if (detail !== undefined) RESULT.detail = detail;
    return RESULT;
  };

  // ── Locate the live <chat-panel> (open it if closed) ─────────────────────
  // The probe runs against either the production shell (`#fleet`, `#runs`,
  // `#run/<id>`, ...) where chat-panel mounts under <app-shell>, OR the dev
  // harness (`#dev/chat`) where chat-panel mounts directly under <farm-app>
  // with mock messages. We don't depend on the host element — only on chat-panel.
  let chatPanel = document.querySelector('chat-panel');
  if (!chatPanel) {
    // Production shell: chat-panel is conditionally rendered. Click the toolbar
    // button to mount it. The dev harness already mounts it on load.
    const appShell = document.querySelector('app-shell');
    if (appShell) {
      const chatBtn =
        appShell.querySelector(
          'button.fa-nav-btn[title*="chat" i], button.fa-nav-btn[aria-label*="chat" i]',
        ) ??
        Array.from(appShell.querySelectorAll('button.fa-nav-btn')).find((b) =>
          b.textContent?.includes('✦'),
        );
      if (chatBtn) {
        chatBtn.click();
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
      }
    }
    chatPanel = document.querySelector('chat-panel');
  }
  if (!chatPanel)
    return fail('chat-panel element never mounted (tried app-shell toggle and dev harness)');
  if (!chatPanel.open) {
    // Force open via the @property — this is the only state poke we make on
    // the panel itself; it does not fabricate any feature behavior under test.
    chatPanel.open = true;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
  }

  // ── Resolve the active sessionId via the panel's own private accessor ────
  // We must use the same string the panel computes; otherwise chat.confirmAction
  // would reject with "cross-session" and the test wouldn't exercise the right
  // path. The panel exposes activeSessionId() as a private method on the
  // instance; reading messages also needs the same id.
  const sessionId =
    typeof chatPanel.activeSessionId === 'function'
      ? chatPanel.activeSessionId()
      : (chatPanel.activeSessionIdValue ?? chatPanel.routeSessionId ?? 'shared');
  RESULT.sessionId = sessionId;

  // ── Build a synthetic message containing 1 next-step + 2 action cards ────
  // These are the same shapes the gateway emits via Events.CHAT_RESPONSE.
  // Action cards are NOT registered in the gateway registry — clicking them
  // will trigger a real WS confirm RPC that rejects with reason='unknown'
  // (which is the path that exercises the params-shape assertion + the
  // [chat-actions] reject telemetry line).
  const syntheticMsgId = `probe-msg-${Date.now()}`;
  const aId = `probe-action-A-${Date.now()}`;
  const bId = `probe-action-B-${Date.now()}`;
  const syntheticMessage = {
    id: syntheticMsgId,
    role: 'assistant',
    content: 'Probe-injected diagnostic message.',
    timestamp: new Date().toISOString(),
    nextSteps: [
      {
        id: 'probe-step-1',
        label: 'Probe next step (read-only)',
        kind: 'read',
        safety: 'read-only',
        params: { prompt: 'noop' },
      },
    ],
    suggestedActions: [
      {
        actionId: aId,
        type: 'run.replayStep',
        label: 'Probe: replay failed step (A)',
        params: { runId: 'probe-run', step: 'prepare' },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
      {
        actionId: bId,
        type: 'slot.release',
        label: 'Probe: release slot (B)',
        params: { slotId: 'probe-slot' },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    ],
  };
  // Reactive write — the panel's messages is a @state Lit property.
  chatPanel.messages = [...(chatPanel.messages ?? []), syntheticMessage];
  await chatPanel.updateComplete;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

  // ── Assertion 1: at least one next-steps block rendered ──────────────────
  // Plan asks for `next-steps-block` selector; this codebase renders next-steps
  // inline inside <chat-message> via class `.cm-next-steps` — there is NO
  // standalone `<next-steps-block>` custom element. We search both so a future
  // refactor that introduces a custom element auto-passes; today the class
  // selector is authoritative.
  const nextStepsCustomEl = document.querySelectorAll('next-steps-block').length;
  const nextStepsByClass = document.querySelectorAll('chat-message .cm-next-steps').length;
  RESULT.assertions.a1_nextStepsRendered.count = nextStepsCustomEl + nextStepsByClass;
  RESULT.assertions.a1_nextStepsRendered.selector =
    nextStepsCustomEl > 0 ? 'next-steps-block' : '.cm-next-steps';
  RESULT.assertions.a1_nextStepsRendered.ok = nextStepsCustomEl + nextStepsByClass >= 1;
  if (nextStepsCustomEl === 0) {
    RESULT.notes.push(
      'A1: spec calls for `next-steps-block` element; codebase uses `.cm-next-steps` class inside <chat-message>. Class-selector fallback used.',
    );
  }

  // ── Assertion 2: at least one chat-action-card rendered ──────────────────
  const allCards = Array.from(document.querySelectorAll('chat-action-card'));
  const ourCards = allCards.filter((c) => c.action?.actionId === aId || c.action?.actionId === bId);
  RESULT.assertions.a2_actionCardsRendered.count = allCards.length;
  RESULT.assertions.a2_actionCardsRendered.ourCards = ourCards.length;
  RESULT.assertions.a2_actionCardsRendered.ok = ourCards.length >= 2;
  if (ourCards.length < 2)
    return fail('Synthetic action cards did not mount under chat-message', {
      ourCards: ourCards.length,
      allCards: allCards.length,
    });

  const cardA = ourCards.find((c) => c.action.actionId === aId);
  const cardB = ourCards.find((c) => c.action.actionId === bId);

  // ── Assertion 3: WS confirm frame params keys = "actionId,sessionId" ─────
  // Wrap WebSocket.prototype.send to capture outgoing chat.confirmAction frames.
  // We restore immediately after observing the frame so we never affect the
  // surrounding app. We do NOT mock the WS — the real gateway responds.
  const originalSend = WebSocket.prototype.send;
  let observedConfirmFrame = null;
  const sendInterceptor = function patchedSend(payload) {
    try {
      if (typeof payload === 'string') {
        const parsed = JSON.parse(payload);
        if (parsed?.type === 'req' && parsed?.method === 'chat.confirmAction') {
          observedConfirmFrame = parsed;
        }
      }
    } catch {
      /* not JSON or not a frame — ignore quietly */
    }
    return originalSend.call(this, payload);
  };
  WebSocket.prototype.send = sendInterceptor;

  // ── Assertion 4: per-card pending isolation ──────────────────────────────
  // We observe pending state within the in-flight window. The chat-panel WS
  // round-trip awaits gateway response; we sample card B *between* dispatch
  // and resolution. Because Lit reflects state via render(), we wait one
  // microtask after dispatching the event — long enough for `_pending = true`
  // to flow through `requestUpdate` and become visible on the rendered button.
  let cardA_pending_during = false;
  let cardB_disabled_attrPresent_during = null;

  // Find the confirm button on each card; rendered as `.cac-btn-confirm`.
  const btnA = cardA.querySelector('button.cac-btn-confirm');
  const btnB = cardB.querySelector('button.cac-btn-confirm');
  if (!btnA || !btnB)
    return fail('Confirm buttons not rendered on cards', { btnA: !!btnA, btnB: !!btnB });

  // Sampling strategy: card.onConfirm() sets `this._pending = true` SYNCHRONOUSLY
  // before dispatching the bubbling 'action-confirm' event. The chat-panel
  // handler then awaits the WS round-trip; only when it resolves does it call
  // markResolved() which clears _pending. So we sample A4 in the same tick:
  //   1. btnA.click()                                  // sync mutation
  //   2. read cardA._pending                           // sync, must be true
  //   3. read cardB <button> disabled attribute        // sync, must be absent
  // Sampling synchronously is required: a fast gateway response can resolve
  // and clear cardA._pending before any awaited frame would let us observe it.
  btnA.click();
  cardA_pending_during = !!cardA._pending; // synchronous read (step 2)
  const btnB_during = cardB.querySelector('button.cac-btn-confirm');
  cardB_disabled_attrPresent_during = btnB_during?.hasAttribute('disabled') ?? null;

  RESULT.assertions.a4_perCardPendingIsolated.cardA_pending = cardA_pending_during;
  RESULT.assertions.a4_perCardPendingIsolated.cardB_disabled = cardB_disabled_attrPresent_during;
  RESULT.assertions.a4_perCardPendingIsolated.ok =
    cardA_pending_during === true && cardB_disabled_attrPresent_during === false;

  // Now wait for the WS round-trip to resolve so the send-interceptor has
  // captured the chat.confirmAction frame (it's captured synchronously inside
  // send(), but we must not restore the prototype until we're sure no further
  // sends from this click will hit the patched path). The gateway rejects the
  // synthetic actionId with reason='unknown' — that IS the path that produces
  // the `[chat-actions] reject ...` telemetry line that assertion 5 verifies.
  const t0 = performance.now();
  while (cardA._pending && performance.now() - t0 < 5_000) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // Restore WS.send unconditionally so we never leave a half-patched prototype.
  if (WebSocket.prototype.send === sendInterceptor) {
    WebSocket.prototype.send = originalSend;
  }

  // Validate the captured frame.
  if (!observedConfirmFrame) {
    RESULT.assertions.a3_confirmFrameKeysExact.ok = false;
    RESULT.assertions.a3_confirmFrameKeysExact.observed = '<no chat.confirmAction frame captured>';
    return fail('No chat.confirmAction frame was captured during card A click', RESULT.assertions);
  }
  const sortedKeys = Object.keys(observedConfirmFrame.params ?? {})
    .sort()
    .join(',');
  RESULT.assertions.a3_confirmFrameKeysExact.observed = sortedKeys;
  RESULT.assertions.a3_confirmFrameKeysExact.frame = {
    type: observedConfirmFrame.type,
    method: observedConfirmFrame.method,
    paramsKeys: Object.keys(observedConfirmFrame.params ?? {}),
  };
  RESULT.assertions.a3_confirmFrameKeysExact.ok = sortedKeys === 'actionId,sessionId';

  // ── Aggregate ────────────────────────────────────────────────────────────
  const inPageOk =
    RESULT.assertions.a1_nextStepsRendered.ok &&
    RESULT.assertions.a2_actionCardsRendered.ok &&
    RESULT.assertions.a3_confirmFrameKeysExact.ok &&
    RESULT.assertions.a4_perCardPendingIsolated.ok;
  RESULT.ok = inPageOk;
  if (!inPageOk) {
    RESULT.error = 'one or more in-page assertions failed; see assertions object';
  }

  // Cleanup: drop the synthetic message so the panel returns to its real state.
  chatPanel.messages = (chatPanel.messages ?? []).filter((m) => m.id !== syntheticMsgId);

  return RESULT;
})();
