/**
 * CDP probe: the two ADR-054 surfaces that do not live on Run Detail — the
 * Slot View capability panel and the backlog dispatch `waitPolicy` field.
 * Usage: node apps/command-center/scripts/cdp.mjs eval backlog --file probes/run-resource-posture-surfaces.js
 *
 * It also makes a real warm provider (acquire, then release with keepWarm) and
 * stops it through the panel's Stop control, which routes to
 * `runtime.capability.stopWarm`, and exercises Restart on a held lease. The outcome is read back from the Gateway, and
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

  /**
   * Poll until the predicate is truthy. The predicate is awaited: an async one
   * returns a Promise, which is always truthy, so calling it without `await`
   * would satisfy the wait on the first tick and read state before the action
   * under test had finished.
   */
  async function waitFor(predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
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

  /** Lease states that mean this owner has not cleanly let go of the capability. */
  const UNCLEARED_LEASE_STATES = ['queued', 'acquiring', 'acquired', 'releasing', 'error'];

  /**
   * Release everything this owner still holds, and keep releasing until nothing
   * comes back. A panel action still in flight can reacquire *after* a single
   * release, which is how an earlier version of this probe stranded a lease it
   * had already reported as cleaned up.
   *
   * `error` counts as uncleared: a lease the Gateway could not clean up is not a
   * tidy teardown, whatever its owner intended. Every thrown release is returned
   * to the caller with its attempt number — a teardown that could not run is the
   * finding, and swallowing it would let a broken cleanup report success.
   */
  async function releaseOwnedUntilClear(ownerRunId, capabilityId) {
    const errors = [];
    let remaining = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await rpc('runtime.capability.release', {
          slotId: SLOT_ID,
          ownerRunId,
          capabilityId,
          keepWarm: false,
        });
      } catch (error) {
        errors.push(`attempt ${attempt}: ${error?.message ?? String(error)}`);
      }
      const status = await rpc('runtime.capability.status', { slotId: SLOT_ID });
      remaining = status.leases.filter(
        (lease) => lease.owner.runId === ownerRunId && UNCLEARED_LEASE_STATES.includes(lease.state),
      ).length;
      if (remaining === 0) return { remaining: 0, errors };
      await wait(1500);
    }
    return { remaining, errors };
  }

  const report = {
    slotId: SLOT_ID,
    // Set by the caller before the probe runs; the page has no build stamp of
    // its own, so evidence would otherwise carry a null SHA.
    testedSha: window.__farmslotProbeSha ?? null,
    capturedAt: new Date().toISOString(),
  };
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
              warmStop.gatewayLeaseState = afterLease?.state ?? null;
              // The panel must never claim a stop the Gateway does not back. This
              // reads the renderer's own dataset and the Gateway's lease record —
              // never the rendered sentence, which is copy that can change.
              warmStop.honest =
                warmStop.noteObservedState !== 'stopped' ||
                (warmStop.gatewayKeepWarmUntil === null &&
                  warmStop.gatewayCleanupFailure === null &&
                  warmStop.gatewayLeaseState !== 'error');
              warmStop.proved = Boolean(warmStop.note && warmStop.noteObservedState);
            }
          }
        }
      }
    } catch (error) {
      warmStop.error = error?.message ?? String(error);
    } finally {
      // Never leave the probe's own lease behind.
      const warmTeardown = warmCapabilityId
        ? await releaseOwnedUntilClear(warmOwnerRunId, warmCapabilityId)
        : { remaining: 0, errors: [] };
      warmStop.leftoverLeases = warmTeardown.remaining;
      warmStop.teardownErrors = warmTeardown.errors;
      if (warmStop.leftoverLeases !== 0) {
        warmStop.cleanupReleaseError = `the probe could not release its own lease (${warmStop.leftoverLeases} still held)`;
      }
      const finalStatus = await rpc('runtime.capability.status', { slotId: SLOT_ID });
      // A lease this probe drove into an error state is a finding, not noise.
      warmStop.leasesInError = finalStatus.leases.filter(
        (lease) => lease.owner.runId === warmOwnerRunId && lease.state === 'error',
      ).length;
    }
    report.warmStop = warmStop;

    // ---- Restart, through the panel's Restart control ----
    //
    // Restart is offered only for a lease this slot still holds, so the setup is
    // an acquire (not a warm release: a released lease offers Acquire and Stop,
    // never Restart). Clicking it makes the panel release with keepWarm false,
    // confirm the Gateway actually listed that lease as released, and reacquire
    // under the recorded proof requirement. Success is a different lease id
    // holding the capability with no cleanup failure behind it.
    const restart = { attempted: false };
    const restartOwnerRunId = `posture-restart-probe-${Date.now()}`;
    let restartCapabilityId = null;
    try {
      const catalog =
        (await rpc('runtime.capability.list', { slotId: SLOT_ID })).capabilities ?? [];
      const entry = catalog.find(
        (candidate) =>
          candidate.availability.state === 'available' &&
          (candidate.dependencies ?? []).length === 0 &&
          candidate.cost.class !== 'high',
      );
      restartCapabilityId = entry?.id ?? null;
      restart.capabilityId = restartCapabilityId;
      if (!entry) {
        restart.skipped =
          'no available dependency-free provider under high cost on this slot to restart';
      } else {
        const acquired = await rpc('runtime.capability.acquire', {
          slotId: SLOT_ID,
          capabilityId: restartCapabilityId,
          ownerRunId: restartOwnerRunId,
          proofRequirement: {
            capabilityId: restartCapabilityId,
            reason: 'restart probe',
            mode: 'state',
          },
        });
        if (!acquired.ok) {
          restart.error = `acquire failed: ${acquired.conflict?.reason ?? 'unknown'}`;
        } else {
          restart.originalLeaseId = acquired.lease.id;
          location.hash = '#fleet';
          await wait(500);
          location.hash = `#slot/${SLOT_ID}?activity=info`;
          const button = await waitFor(
            () => deepAll(`[data-testid="runtime-capability-restart-${restartCapabilityId}"]`)[0],
            25000,
          );
          if (!button) {
            restart.error = 'the panel offered no Restart control for the held lease';
          } else {
            restart.attempted = true;
            button.click();
            // Either a new lease is holding the capability, or the panel says why.
            await waitFor(async () => {
              const failed = deepAll('[data-testid="runtime-capability-action-error"]')[0];
              if (failed) return failed;
              const status = await rpc('runtime.capability.status', { slotId: SLOT_ID });
              return status.leases.some(
                (lease) =>
                  lease.capabilityId === restartCapabilityId &&
                  lease.owner.runId === restartOwnerRunId &&
                  lease.state === 'acquired' &&
                  lease.id !== restart.originalLeaseId,
              );
            }, 150000);
            restart.actionError = text(
              deepAll('[data-testid="runtime-capability-action-error"]')[0],
            );
            const after = await rpc('runtime.capability.status', { slotId: SLOT_ID });
            const mine = after.leases.filter(
              (lease) =>
                lease.capabilityId === restartCapabilityId &&
                lease.owner.runId === restartOwnerRunId,
            );
            const original = mine.find((lease) => lease.id === restart.originalLeaseId);
            const replacement = mine.find(
              (lease) => lease.id !== restart.originalLeaseId && lease.state === 'acquired',
            );
            restart.originalLeaseState = original?.state ?? null;
            restart.newLeaseId = replacement?.id ?? null;
            restart.cleanupFailure =
              mine.map((lease) => lease.cleanupFailure).find(Boolean) ?? null;
            // The three things that make this a restart rather than a no-op: the
            // original lease is gone, a different lease holds the capability, and
            // nothing failed on the way.
            restart.originalReleased = original?.state === 'released';
            restart.reacquired = Boolean(replacement);
            restart.proved = Boolean(
              restart.originalReleased && restart.reacquired && !restart.cleanupFailure,
            );
          }
        }
      }
    } catch (error) {
      restart.error = error?.message ?? String(error);
    } finally {
      const teardown = restartCapabilityId
        ? await releaseOwnedUntilClear(restartOwnerRunId, restartCapabilityId)
        : { remaining: 0, errors: [] };
      restart.leftoverLeases = teardown.remaining;
      restart.teardownErrors = teardown.errors;
      // Re-read AFTER the teardown. The earlier snapshot was taken before any
      // cleanup ran, so a failure the teardown itself caused was invisible.
      const post = await rpc('runtime.capability.status', { slotId: SLOT_ID });
      const postMine = post.leases.filter((lease) => lease.owner.runId === restartOwnerRunId);
      restart.cleanupFailure =
        postMine.map((lease) => lease.cleanupFailure).find(Boolean) ??
        restart.cleanupFailure ??
        null;
      restart.leasesInError = postMine.filter((lease) => lease.state === 'error').length;
      if (restart.leftoverLeases !== 0) {
        restart.cleanupReleaseError = `the probe could not release its restarted lease (${restart.leftoverLeases} still held)`;
      }
    }
    report.restart = restart;

    // The warm Stop is the Slot View action this probe proves: a real click on a
    // real control with a Gateway-verified outcome. The acquire attempt above is
    // opportunistic — it needs a run bound to the slot, which is not always
    // true — so it does not gate `ok`.
    // A probe that leaves state behind, or cannot put back what it changed, has
    // not passed: the next run would start from a different world than this saw.
    const failures = [];
    if (!report.backlog?.persisted) failures.push('the backlog wait policy did not persist');
    if (report.backlog?.attempted && !report.backlog?.restored) {
      failures.push(
        `the backlog wait policy was not restored (left '${report.backlog?.restoredWaitPolicy ?? 'unset'}', expected '${report.backlog?.originalWaitPolicy ?? 'unset'}')`,
      );
    }
    if (!report.slotView?.rowsSeparateLeaseAndProvider) {
      failures.push('a capability row did not report lease state and provider state separately');
    }
    if (!report.warmStop?.proved) failures.push('the warm Stop produced no Gateway outcome');
    if (!report.warmStop?.honest) failures.push('the warm Stop claimed a stop it did not observe');
    if (report.warmStop?.cleanupReleaseError) failures.push(report.warmStop.cleanupReleaseError);
    // A cleanup that failed is not a pass, however the rest of the run went.
    if (report.warmStop?.gatewayCleanupFailure) {
      failures.push(`warm cleanup failed: ${report.warmStop.gatewayCleanupFailure}`);
    }
    if (report.warmStop?.error) failures.push(`warm Stop node errored: ${report.warmStop.error}`);
    if (report.warmStop?.gatewayLeaseState === 'error') {
      failures.push('the Gateway left the warm lease in error state');
    }
    if (report.warmStop?.leasesInError) {
      failures.push(`${report.warmStop.leasesInError} lease(s) left in error state on the slot`);
    }
    if (!report.restart?.proved) {
      failures.push(
        report.restart?.skipped ??
          report.restart?.error ??
          report.restart?.actionError ??
          'Restart did not release the original lease and reacquire a new one',
      );
    }
    if (report.restart?.cleanupFailure) {
      failures.push(`restart cleanup failed: ${report.restart.cleanupFailure}`);
    }
    if (report.restart?.cleanupReleaseError) failures.push(report.restart.cleanupReleaseError);
    if (report.restart?.teardownErrors?.length) {
      failures.push(`restart teardown release failed: ${report.restart.teardownErrors.join('; ')}`);
    }
    if (report.restart?.leasesInError) {
      failures.push(`${report.restart.leasesInError} restart lease(s) left in error state`);
    }
    if (report.warmStop?.teardownErrors?.length) {
      failures.push(
        `warm Stop teardown release failed: ${report.warmStop.teardownErrors.join('; ')}`,
      );
    }
    if (report.restart?.leftoverLeases !== 0) {
      failures.push(`${report.restart?.leftoverLeases} restart lease(s) left behind by this probe`);
    }
    if (report.warmStop?.leftoverLeases !== 0) {
      failures.push(`${report.warmStop?.leftoverLeases} lease(s) left behind by this probe`);
    }
    report.failures = failures;
    report.ok = failures.length === 0;
    return report;
  } finally {
    socket.close();
  }
})();
