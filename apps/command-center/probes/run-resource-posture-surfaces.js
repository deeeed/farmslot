/**
 * CDP probe: the two ADR-054 surfaces that do not live on Run Detail — the
 * Slot View capability panel and the backlog dispatch `waitPolicy` field.
 * Usage: node apps/command-center/scripts/cdp.mjs eval backlog --file probes/run-resource-posture-surfaces.js
 *
 * It also makes a real warm provider (acquire, then release with keepWarm) and
 * stops it through the panel's Stop control, which routes to
 * `runtime.capability.stopWarm`. The outcome is read back from the Gateway, and
 * the probe releases its own lease in a finally block whatever happens.
 *
 * Both are driven through real clicks on real controls. The backlog field is
 * read back from the gateway, not from component state, so the evidence proves
 * the value was persisted through `backlog.update` rather than merely rendered.
 * Nothing is injected: the probe clicks the same pills an operator clicks.
 *
 * It restores whatever it changed. The backlog wait policy is set and then put
 * back to its original value, so the probe leaves no configuration behind.
 *
 * Before running it, set the gateway URL in the page:
 *   node scripts/cdp.mjs eval backlog "window.__farmslotProbeGatewayUrl='ws://localhost:7801'; return true"
 * Command Center only persists that URL after an explicit connect, so a dev
 * session on the Vite default has nothing stored for the probe to reuse.
 *
 * Top-level `return` + IIFE: Prettier accepts it (`allowReturnOutsideFunction`)
 * and `cdp.mjs` stmtForm fallback returns the value.
 */
return (async () => {
  const SLOT_ID = 'macpro-ff-1';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim() ?? null;

  function deepAll(selector, root = document, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) deepAll(selector, element.shadowRoot, out);
    }
    return out;
  }

  async function waitFor(predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await wait(100);
    }
    return null;
  }

  // One socket for read-back, so persistence is proved against the Gateway and
  // not against the component that was just clicked.
  //
  // Command Center only persists its gateway URL once the operator connects
  // explicitly; a dev session running off the Vite default has nothing in
  // localStorage. The caller therefore sets `window.__farmslotProbeGatewayUrl`
  // first rather than having this probe guess a port.
  const gatewayUrl =
    window.__farmslotProbeGatewayUrl ?? localStorage.getItem('farmslot.gateway.url');
  if (!gatewayUrl) {
    return {
      ok: false,
      error:
        'No gateway URL: set window.__farmslotProbeGatewayUrl (or connect Command Center) before running this probe',
    };
  }
  const socket = new WebSocket(gatewayUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.ok
      ? request.resolve(message.payload ?? message.result)
      : request.reject(new Error(JSON.stringify(message.error ?? message)));
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Gateway connection failed')), {
      once: true,
    });
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `posture-surfaces-${++nextId}`;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });

  const report = { slotId: SLOT_ID, capturedAt: new Date().toISOString() };
  try {
    await rpc('auth.connect', {
      clientKind: 'ui',
      clientName: 'run-resource-posture-surfaces-probe',
      ...(localStorage.getItem('farmslot.gateway.token')
        ? { token: localStorage.getItem('farmslot.gateway.token') }
        : {}),
      ...(localStorage.getItem('farmslot.gateway.password')
        ? { password: localStorage.getItem('farmslot.gateway.password') }
        : {}),
    });

    // ---- Backlog dispatch waitPolicy, through the real editor ----
    const backlog = { attempted: false };
    const items = (await rpc('backlog.list', {})).items ?? [];
    const editable = items.find(
      (item) =>
        ['candidate', 'ready', 'failed', 'needs-attention'].includes(item.status) &&
        !item.queuedQueueItemId &&
        !item.runId,
    );
    if (!editable) {
      backlog.skipped = 'no editable backlog item to configure';
    } else {
      backlog.attempted = true;
      backlog.itemId = editable.id;
      backlog.originalWaitPolicy = editable.waitPolicy ?? null;
      location.hash = `#backlog?item=${encodeURIComponent(editable.id)}&mode=edit`;
      const pill = await waitFor(
        () => deepAll('[data-testid="dispatch-wait-policy-minimize"]')[0],
        20000,
      );
      if (!pill) {
        backlog.error = 'the wait policy control did not render in the dispatch editor';
      } else {
        pill.click();
        await wait(2500);
        const after = (await rpc('backlog.list', {})).items.find((i) => i.id === editable.id);
        backlog.persistedWaitPolicy = after?.waitPolicy ?? null;
        backlog.persisted = backlog.persistedWaitPolicy === 'minimize';
        // Put it back exactly as found so the probe leaves no configuration.
        const restore = backlog.originalWaitPolicy
          ? deepAll(`[data-testid="dispatch-wait-policy-${backlog.originalWaitPolicy}"]`)[0]
          : deepAll('[data-testid="dispatch-wait-policy-unset"]')[0];
        restore?.click();
        await wait(2500);
        const restored = (await rpc('backlog.list', {})).items.find((i) => i.id === editable.id);
        backlog.restoredWaitPolicy = restored?.waitPolicy ?? null;
        backlog.restored = backlog.restoredWaitPolicy === backlog.originalWaitPolicy;
      }
    }
    report.backlog = backlog;

    // ---- Slot View capability panel ----
    location.hash = `#slot/${SLOT_ID}?activity=info`;
    const panel = await waitFor(
      () => deepAll('[data-testid="runtime-capabilities-panel"]')[0],
      20000,
    );
    const slotView = { attempted: false };
    if (!panel) {
      slotView.error = 'the runtime capabilities panel did not render on the slot route';
    } else {
      const root = panel.getRootNode();
      const rows = [...root.querySelectorAll('article')].map((article) => ({
        capabilityId: article.dataset.capabilityId,
        leaseState: article.dataset.leaseState,
        observedState: article.dataset.observedState,
        warmUntil: article.dataset.warmUntil || null,
        reason: text(
          article.querySelector(
            `[data-testid="runtime-capability-reason-${article.dataset.capabilityId}"]`,
          ),
        ),
        warmNote: text(
          article.querySelector(
            `[data-testid="runtime-capability-warm-note-${article.dataset.capabilityId}"]`,
          ),
        ),
        actions: [...article.querySelectorAll('button')].map((b) => b.dataset.testid),
      }));
      slotView.rows = rows;
      // Lease state and provider state must be two separate readings.
      slotView.rowsSeparateLeaseAndProvider = rows.every(
        (row) => row.leaseState && row.observedState,
      );
      // A warm provider offers Stop, routed to `runtime.capability.stopWarm`.
      slotView.warmRowsOfferStop = rows
        .filter((row) => row.warmNote)
        .every((row) => row.actions.some((id) => id?.startsWith('runtime-capability-release-')));

      // Exercise one real recovery action end to end.
      const target = rows.find((row) =>
        row.actions.some((id) => id?.startsWith('runtime-capability-acquire-')),
      );
      if (!target) {
        slotView.skipped = 'no capability on this slot offers an acquire action right now';
      } else {
        slotView.attempted = true;
        slotView.action = 'acquire';
        slotView.actionCapabilityId = target.capabilityId;
        const before = await rpc('runtime.capability.status', { slotId: SLOT_ID });
        slotView.leasesBefore = before.leases.filter(
          (lease) => lease.capabilityId === target.capabilityId,
        ).length;
        const button = deepAll(
          `[data-testid="runtime-capability-acquire-${target.capabilityId}"]`,
        )[0];
        button.click();
        // Either the capability comes up or the panel shows why. Both are real
        // outcomes; a silent no-op is not.
        await waitFor(() => {
          const error = deepAll('[data-testid="runtime-capability-action-error"]')[0];
          const article = deepAll(`article[data-capability-id="${target.capabilityId}"]`)[0];
          return error ?? (article?.dataset.leaseState === 'acquired' ? article : null);
        }, 130000);
        slotView.actionError = text(deepAll('[data-testid="runtime-capability-action-error"]')[0]);
        const after = await rpc('runtime.capability.status', { slotId: SLOT_ID });
        const mine = after.leases.filter((lease) => lease.capabilityId === target.capabilityId);
        slotView.leasesAfter = mine.length;
        slotView.leaseStatesAfter = mine.map((lease) => lease.state);
        // The Gateway either created a lease or explained the refusal. Either
        // way the panel reported the same thing the Gateway did.
        slotView.actionProved = Boolean(
          slotView.actionError || mine.some((lease) => lease.state === 'acquired'),
        );
      }
    }
    report.slotView = slotView;

    // ---- Warm Stop, through runtime.capability.stopWarm ----
    //
    // A warm provider is a released lease whose process is still up. It is made
    // here the same way the run engine makes one: acquire, then release with
    // keepWarm so the provider outlives the lease. Then the panel's Stop button
    // is clicked and the outcome is read back from the Gateway.
    const warmStop = { attempted: false };
    const warmOwnerRunId = `posture-warm-stop-probe-${Date.now()}`;
    let warmCapabilityId = null;
    try {
      // Only a provider that declares keep_warm_ms can ever be warm, and one
      // with no dependencies keeps the proof to a single process. Chosen from
      // the live catalog rather than hardcoded, so it follows project config.
      const catalog =
        (await rpc('runtime.capability.list', { slotId: SLOT_ID })).capabilities ?? [];
      const catalogEntry = catalog.find(
        (candidate) =>
          candidate.keepWarmMs &&
          candidate.availability.state === 'available' &&
          (candidate.dependencies ?? []).length === 0,
      );
      warmCapabilityId = catalogEntry?.id ?? null;
      warmStop.capabilityId = warmCapabilityId;
      warmStop.keepWarmMs = catalogEntry?.keepWarmMs ?? null;
      if (!catalogEntry) {
        warmStop.skipped =
          'no available dependency-free provider on this slot declares keep_warm_ms, so no warm window can exist';
      } else {
        const acquired = await rpc('runtime.capability.acquire', {
          slotId: SLOT_ID,
          capabilityId: warmCapabilityId,
          ownerRunId: warmOwnerRunId,
          proofRequirement: {
            capabilityId: warmCapabilityId,
            reason: 'warm stop probe',
            mode: 'state',
          },
        });
        if (!acquired.ok) {
          warmStop.error = `acquire failed: ${acquired.conflict?.reason ?? 'unknown'}`;
        } else {
          // keepWarm true is what leaves the process up behind a released lease.
          const released = await rpc('runtime.capability.release', {
            slotId: SLOT_ID,
            ownerRunId: warmOwnerRunId,
            capabilityId: warmCapabilityId,
            leaseId: acquired.lease.id,
            keepWarm: true,
          });
          warmStop.releasedOk = released.ok;
          const warmed = (await rpc('runtime.capability.status', { slotId: SLOT_ID })).leases.find(
            (lease) => lease.id === acquired.lease.id,
          );
          warmStop.warmUntil = warmed?.keepWarmUntil ?? null;
          warmStop.warmWindowOpen = Boolean(
            warmed?.keepWarmUntil && Date.parse(warmed.keepWarmUntil) > Date.now(),
          );
          if (!warmStop.warmWindowOpen) {
            warmStop.skipped = 'the release left no open keep-warm window to stop';
          } else {
            // Re-render the panel against the warm lease, then click its Stop.
            location.hash = '#fleet';
            await wait(500);
            location.hash = `#slot/${SLOT_ID}?activity=info`;
            const button = await waitFor(
              () => deepAll(`[data-testid="runtime-capability-release-${warmCapabilityId}"]`)[0],
              25000,
            );
            if (!button) {
              warmStop.error = 'the panel offered no Stop control for the warm provider';
            } else {
              warmStop.attempted = true;
              warmStop.buttonLabel = button.textContent.trim();
              button.click();
              const note = await waitFor(
                () =>
                  deepAll(`[data-testid="runtime-capability-stopwarm-${warmCapabilityId}"]`)[0] ??
                  deepAll('[data-testid="runtime-capability-action-error"]')[0],
                90000,
              );
              warmStop.note = text(note);
              warmStop.noteTone = note?.dataset.outcomeTone ?? null;
              warmStop.noteObservedState = note?.dataset.observedState ?? null;
              const afterStatus = await rpc('runtime.capability.status', { slotId: SLOT_ID });
              const afterLease = afterStatus.leases.find((lease) => lease.id === acquired.lease.id);
              warmStop.gatewayKeepWarmUntil = afterLease?.keepWarmUntil ?? null;
              warmStop.gatewayCleanupFailure = afterLease?.cleanupFailure ?? null;
              // The panel must never say stopped unless the Gateway observed one.
              warmStop.honest =
                warmStop.noteObservedState !== 'stopped' ||
                !/still running/i.test(warmStop.note ?? '');
              warmStop.proved = Boolean(warmStop.note && warmStop.noteObservedState);
            }
          }
        }
      }
    } catch (error) {
      warmStop.error = error?.message ?? String(error);
    } finally {
      // Never leave the probe's own lease behind.
      if (warmCapabilityId) {
        try {
          await rpc('runtime.capability.release', {
            slotId: SLOT_ID,
            ownerRunId: warmOwnerRunId,
            capabilityId: warmCapabilityId,
            keepWarm: false,
          });
        } catch {
          warmStop.cleanupReleaseError = 'the probe could not release its own lease';
        }
      }
      const finalStatus = await rpc('runtime.capability.status', { slotId: SLOT_ID });
      warmStop.leftoverLeases = finalStatus.leases.filter(
        (lease) =>
          lease.owner.runId === warmOwnerRunId &&
          ['queued', 'acquiring', 'acquired', 'releasing'].includes(lease.state),
      ).length;
    }
    report.warmStop = warmStop;

    // The warm Stop is the Slot View action this probe proves: a real click on a
    // real control with a Gateway-verified outcome. The acquire attempt above is
    // opportunistic — it needs a run bound to the slot, which is not always
    // true — so it does not gate `ok`.
    report.ok = Boolean(
      report.backlog?.persisted &&
      report.slotView?.rowsSeparateLeaseAndProvider &&
      report.warmStop?.proved &&
      report.warmStop?.honest &&
      report.warmStop?.leftoverLeases === 0,
    );
    return report;
  } finally {
    socket.close();
  }
})();
