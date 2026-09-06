/**
 * CDP probe: the ADR-054 `free-slot` gate-park surfaces on Run Detail.
 *
 * Usage:
 *   node scripts/cdp.mjs eval - "window.__farmslotProbeGatewayUrl='ws://localhost:7801'; window.__farmslotProbeRunId='<run-id>'; return true"
 *   node scripts/cdp.mjs eval run/<run-id> --file probes/run-gate-park-surfaces.js --out <evidence.json>
 *
 * What it proves, against a real run on the live fleet:
 *
 *   1. A run whose park is settled shows no gate-park block and no freed-slot
 *      marker on its Slot badge. That is the control: every later assertion
 *      would pass trivially if the block were always on screen.
 *   2. Applying the `free-slot` gate choice through `runtime.posture.apply` —
 *      the same protocol action the gate's "Free the slot" choice resolves to —
 *      really frees the slot, and Run Detail then names the parked state, the
 *      freed slot, the preserved branch and tip, and the restore target, says
 *      that answering the gate restores the run into that slot first, and marks
 *      the Slot badge as freed for dispatch.
 *   3. `machine.pause.restore` puts the run back, and every one of those
 *      surfaces goes away again while the gate stays pending, with the
 *      preserved branch back at the SAME tip and the SAME decision ids pending.
 *   4. A negative control: a run with no park record at all renders none of it,
 *      so a surface hard-wired to show a gate park cannot pass this probe.
 *
 * Nothing is injected. The park and the restore are real protocol actions on a
 * real slot, and everything asserted is read out of the rendered DOM after the
 * Gateway's own run record came back over the wire. The probe never resolves
 * the decision: the gate is left exactly as pending as it found it.
 *
 * The run id is required rather than discovered. Parking a run stops its worker
 * and hands its slot to dispatch, so this must never pick a run for itself.
 *
 * Top-level `return` + IIFE: Prettier accepts it (`allowReturnOutsideFunction`)
 * and `cdp.mjs` stmtForm fallback returns the value.
 */
return (async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim() ?? null;

  function deepAll(selector, root = document, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) deepAll(selector, element.shadowRoot, out);
    }
    return out;
  }

  /** Poll until the predicate resolves truthy. The predicate is awaited, so an async one is honoured. */
  async function waitFor(predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await wait(250);
    }
    return null;
  }

  const runId = window.__farmslotProbeRunId;
  if (!runId) {
    return {
      ok: false,
      error:
        'No run id: set window.__farmslotProbeRunId before running this probe. It parks a real run, so it must never choose one itself.',
    };
  }
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
      const id = `gate-park-${++nextId}`;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });

  const parkFacts = (run) => ({
    phase: run.park?.phase ?? null,
    slotDisposition: run.park?.slotDisposition ?? null,
    slotFreedAt: run.park?.slotFreedAt ?? null,
    slotReboundAt: run.park?.slotReboundAt ?? null,
    preservedBranch: run.park?.preservedWorkspace?.branch ?? null,
    preservedHeadSha: run.park?.preservedWorkspace?.headSha ?? null,
    restoreStages: run.park?.restoreProgress?.completed ?? null,
    refusal: run.park?.restoreRefusal?.code ?? null,
    workerProofKind: run.park?.recoveryProof?.acknowledgement?.kind ?? null,
  });

  const pendingDecisionIds = (run) =>
    (run.decisions ?? []).filter((decision) => !decision.resolvedAt).map((decision) => decision.id);

  /**
   * Re-enter Run Detail so the surfaces render against the run the Gateway has
   * NOW. Leaving and returning is what a reconnecting operator does; it is not
   * a state write, and nothing about the run is touched on the way.
   */
  async function renderRunDetail() {
    location.hash = '#runs';
    await wait(400);
    location.hash = `#run/${runId}`;
    await waitFor(() => deepAll('[data-testid="run-posture"]')[0] ?? deepAll('.header h2')[0]);
    await wait(1200);
  }

  /** Everything the gate-park surfaces are claiming right now, read out of the DOM. */
  function readSurfaces() {
    const park = deepAll('[data-testid="run-posture-gate-park"]')[0];
    const notice = deepAll('[data-testid="run-posture-park-notice"]')[0];
    const badge = deepAll('[data-testid="run-slot-freed-by-park"]')[0];
    return {
      parkBlockPresent: Boolean(park),
      parkSlotState: park?.dataset.slotState ?? null,
      parkSlotDisposition: park?.dataset.slotDisposition ?? null,
      parkFreedSlot: park?.dataset.freedSlot || null,
      parkRestoreFirst: park?.dataset.restoreFirst ?? null,
      parkRestoreAvailable: park?.dataset.restoreAvailable ?? null,
      parkState: text(deepAll('[data-testid="run-posture-gate-park-state"]')[0]),
      parkSummary: text(deepAll('[data-testid="run-posture-gate-park-summary"]')[0]),
      parkFreedLine: text(deepAll('[data-testid="run-posture-gate-park-freed"]')[0]),
      parkTargetLine: text(deepAll('[data-testid="run-posture-gate-park-target"]')[0]),
      parkRefusalLine: text(deepAll('[data-testid="run-posture-gate-park-refusal"]')[0]),
      noticePresent: Boolean(notice),
      noticeKind: notice?.dataset.kind ?? null,
      noticeText: text(notice),
      slotBadgeFreedMarker: text(badge),
      postureName: text(deepAll('[data-testid="run-posture-name"]')[0]),
    };
  }

  const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
  const report = {
    runId,
    testedSha: window.__farmslotProbeSha ?? null,
    capturedAt: new Date().toISOString(),
  };
  const failures = [];
  try {
    await rpc('auth.connect', {
      clientKind: 'ui',
      clientName: 'run-gate-park-surfaces-probe',
      ...(localStorage.getItem('farmslot.gateway.token')
        ? { token: localStorage.getItem('farmslot.gateway.token') }
        : {}),
      ...(localStorage.getItem('farmslot.gateway.password')
        ? { password: localStorage.getItem('farmslot.gateway.password') }
        : {}),
    });

    // ---- 1. Control: a settled park claims nothing ----
    const initial = (await rpc('run.get', { runId })).run;
    report.slotId = initial.slotId;
    report.machine = initial.park?.machine ?? null;
    report.before = { park: parkFacts(initial), pendingDecisions: pendingDecisionIds(initial) };
    if (
      report.before.pendingDecisions.length === 0 &&
      !TERMINAL_STATUSES.includes(initial.status)
    ) {
      failures.push('the run has no pending decision, so there is no gate to describe');
    }
    if (initial.park && initial.park.phase !== 'restored' && initial.park.phase !== 'cancelled') {
      failures.push(
        `the run already has a live park record (phase '${initial.park.phase}'); this probe expects a settled starting point`,
      );
    }
    // A terminal run cannot be parked at all, so the park cycle below would
    // fail on the Gateway's refusal rather than on anything this probe is
    // about. Reported as an unmet precondition, not as a surface defect: the
    // controls above still ran and still mean what they say.
    report.parkable = !TERMINAL_STATUSES.includes(initial.status);
    report.runStatus = initial.status;
    await renderRunDetail();
    report.before.surfaces = readSurfaces();
    if (report.before.surfaces.parkBlockPresent) {
      failures.push('a settled park still rendered a gate-park block');
    }
    if (report.before.surfaces.noticePresent) {
      failures.push('a settled park still rendered a gate notice');
    }
    if (report.before.surfaces.slotBadgeFreedMarker) {
      failures.push('the Slot badge claimed a freed slot before anything was freed');
    }

    // ---- 2. Negative control ----
    //
    // Every assertion above is of the form "the surface said X while the record
    // said X". None of them can fail if the surface simply says X always. This
    // renders a run that has NO park record at all and requires the surfaces to
    // go silent — the same check the settled control makes, against a different
    // record shape, so a renderer hard-wired to show a gate park is caught.
    const control = { attempted: false };
    const other = (await rpc('run.list', { limit: 40 })).runs.find(
      (candidate) => candidate.id !== runId && !candidate.park,
    );
    if (!other) {
      control.skipped = 'no run without a park record on this gateway to use as a control';
    } else {
      control.attempted = true;
      control.runId = other.id;
      location.hash = '#runs';
      await wait(400);
      location.hash = `#run/${other.id}`;
      await waitFor(() => deepAll('.header h2')[0]);
      await wait(1200);
      const surfaces = readSurfaces();
      control.surfaces = surfaces;
      if (surfaces.parkBlockPresent) {
        failures.push('a run with no park record still rendered a gate-park block');
      }
      if (surfaces.noticePresent) {
        failures.push('a run with no park record still rendered a gate notice');
      }
      if (surfaces.slotBadgeFreedMarker) {
        failures.push('a run with no park record still marked its slot freed');
      }
    }
    report.control = control;

    // ---- 3. Park with `free-slot`, the choice the gate resolves to ----
    if (!report.parkable) {
      report.parkCycleSkipped = `run ${runId} is '${initial.status}', so it cannot be parked; supply a gate-held run to prove the park cycle`;
      report.failures = failures;
      report.ok = failures.length === 0;
      return report;
    }
    const plan = await rpc('runtime.posture.preview', { runId, gateChoice: 'free-slot' });
    report.previewPlan = {
      posture: plan.posture,
      policySource: plan.policySource,
      slotId: plan.slotId,
      rejection: plan.rejection ?? null,
      effects: plan.effects,
    };
    if (plan.rejection) {
      failures.push(
        `the Gateway refused the free-slot preview (${plan.rejection.code ?? plan.rejection.kind}): ${plan.rejection.reason}`,
      );
    } else {
      const applied = await rpc('runtime.posture.apply', { runId, gateChoice: 'free-slot' });
      report.applyOutcome = {
        ok: applied.ok,
        posture: applied.status.posture,
        transitionOutcome: applied.transition.outcome,
        rejection: applied.transition.rejection ?? null,
        effects: applied.transition.effects,
      };
      const freed = await waitFor(async () => {
        const run = (await rpc('run.get', { runId })).run;
        return run.park?.slotFreedAt && !run.park?.slotReboundAt ? run : null;
      }, 180000);
      if (!freed) {
        failures.push('the free-slot park never recorded a released slot');
      } else {
        report.parked = { park: parkFacts(freed), pendingDecisions: pendingDecisionIds(freed) };
        await renderRunDetail();
        const surfaces = readSurfaces();
        report.parked.surfaces = surfaces;
        if (!surfaces.parkBlockPresent) failures.push('the parked run rendered no gate-park block');
        if (surfaces.parkSlotState !== 'freed') {
          failures.push(`the gate-park block read slot state '${surfaces.parkSlotState}'`);
        }
        if (surfaces.parkFreedSlot !== freed.park.slotId) {
          failures.push(
            `the gate-park block named freed slot '${surfaces.parkFreedSlot}' for a park on '${freed.park.slotId}'`,
          );
        }
        const branch = freed.park.preservedWorkspace?.branch;
        if (branch && !(surfaces.parkSummary ?? '').includes(branch)) {
          failures.push(`the gate-park summary did not name the preserved branch '${branch}'`);
        }
        if (!(surfaces.parkTargetLine ?? '').includes(freed.park.slotId)) {
          failures.push('the gate-park block did not name the restore target');
        }
        // Availability is not read on this surface, so it must say so rather
        // than claim the slot is free.
        if (surfaces.parkRestoreAvailable !== 'unknown') {
          failures.push(
            `Run Detail claimed restore availability '${surfaces.parkRestoreAvailable}' without a Gateway verdict`,
          );
        }
        if (!surfaces.noticePresent) {
          failures.push('the gate showed no notice that answering would restore the run first');
        }
        if (surfaces.noticeKind !== 'restore-first' && surfaces.noticeKind !== 'restore-blocked') {
          failures.push(`the gate notice reported kind '${surfaces.noticeKind}'`);
        }
        if (!(surfaces.noticeText ?? '').includes(freed.park.slotId)) {
          failures.push('the gate notice did not name the slot the run would be restored into');
        }
        if (!surfaces.slotBadgeFreedMarker) {
          failures.push('the Slot badge did not mark the freed slot as freed for dispatch');
        }
        // Exact ids, not a count. A park that resolved one decision and opened
        // another keeps the count identical while having consumed the gate this
        // probe promised not to touch.
        if (report.parked.pendingDecisions.join(',') !== report.before.pendingDecisions.join(',')) {
          failures.push(
            `the park changed which decisions are pending: ${report.before.pendingDecisions.join(',')} -> ${report.parked.pendingDecisions.join(',')}`,
          );
        }
        const headSha = freed.park.preservedWorkspace?.headSha;
        if (!headSha) {
          failures.push('the freeing park recorded no preserved tip to restore the branch to');
        } else if (!(surfaces.parkSummary ?? '').includes(headSha)) {
          failures.push(
            `the gate-park summary did not name the preserved tip ${headSha}; a branch name without its commit identifies nothing`,
          );
        }
        if (!freed.park.preservedWorkspace?.detachedAt) {
          failures.push('the park did not record when it detached the branch');
        }
      }

      // ---- 3. Restore, and every surface goes away ----
      const headShaBeforeRestore = freed?.park.preservedWorkspace?.headSha ?? null;
      const restorePreview = await rpc('machine.pause.restore', {
        machine: freed?.park.machine ?? initial.park?.machine,
        selector: { kind: 'include', runIds: [runId] },
        execute: false,
      });
      const previewRun = restorePreview.runs.find((entry) => entry.runId === runId);
      report.restorePreview = {
        previewId: restorePreview.previewId,
        eligibility: previewRun?.eligibility ?? null,
        restoreTarget: previewRun?.restoreTarget ?? null,
      };
      if (!previewRun?.eligibility.eligible) {
        failures.push(
          `the Gateway refused to restore the parked run (${previewRun?.eligibility.code}): ${previewRun?.eligibility.reason}`,
        );
      } else {
        const restored = await rpc('machine.pause.restore', {
          machine: freed?.park.machine ?? initial.park?.machine,
          selector: { kind: 'include', runIds: [runId] },
          execute: true,
          previewId: restorePreview.previewId,
          reviewedTargets: [{ runId, generation: previewRun.generation }],
        });
        report.restoreOutcome = { ok: restored.ok, outcome: restored.outcome };
        const settled = await waitFor(async () => {
          const run = (await rpc('run.get', { runId })).run;
          return run.park?.phase === 'restored' ? run : null;
        }, 240000);
        if (!settled) {
          failures.push('the restore never settled the park record');
        } else {
          report.after = {
            park: parkFacts(settled),
            pendingDecisions: pendingDecisionIds(settled),
          };
          await renderRunDetail();
          const surfaces = readSurfaces();
          report.after.surfaces = surfaces;
          if (surfaces.parkBlockPresent) {
            failures.push('the restored run still rendered a gate-park block');
          }
          if (surfaces.noticePresent) {
            failures.push('the restored run still warned that answering would restore it first');
          }
          if (surfaces.slotBadgeFreedMarker) {
            failures.push('the Slot badge still claimed the slot was freed after the restore');
          }
          if (
            report.after.pendingDecisions.join(',') !== report.before.pendingDecisions.join(',')
          ) {
            failures.push(
              `the restore changed which decisions are pending: ${report.before.pendingDecisions.join(',')} -> ${report.after.pendingDecisions.join(',')}`,
            );
          }
          // The preserved branch must come back at the SAME tip. A restore that
          // checked out the branch at a different commit has silently moved the
          // run's work, which no status field reports.
          const restoredSha = settled.park.preservedWorkspace?.headSha;
          if (restoredSha !== headShaBeforeRestore) {
            failures.push(
              `the preserved tip changed across the restore: ${headShaBeforeRestore} -> ${restoredSha}`,
            );
          }
        }
      }
    }

    report.failures = failures;
    report.ok = failures.length === 0;
    return report;
  } catch (error) {
    report.failures = [...failures, `probe threw: ${error?.message ?? String(error)}`];
    report.ok = false;
    return report;
  } finally {
    socket.close();
  }
})();
