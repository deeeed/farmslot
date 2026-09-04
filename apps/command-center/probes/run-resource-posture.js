/**
 * CDP probe: Run Detail resource posture (ADR-054) and the human-gate choices.
 * Usage: node apps/command-center/scripts/cdp.mjs eval run/<runId> --file probes/run-resource-posture.js \
 *          --out docs/operations/evidence/cc-probe-run-resource-posture.json
 *
 * Reads what the rendered page actually shows: the posture summary panel and
 * one row per capability, with the Gateway's desired disposition next to the
 * observed provider state. Nothing is written into component state — the panel
 * only has content after `runtime.posture.status` answered, so its presence is
 * the proof that the RPC ran through the real UI path.
 *
 * The gate section is exercised only when the run actually has an unresolved
 * decision that renders posture choices. Clicking a choice fires the real
 * `runtime.posture.preview` round trip; the preview lines that appear are the
 * Gateway's plan, not text this probe supplied. When no such gate is pending the
 * probe records `gate.skipped` with the reason rather than reporting a pass it
 * did not earn.
 *
 * `ok` requires a posture panel with at least one capability row AND a proved
 * gate. A run that renders the panel but never exercises a gate has not proved
 * the deliverable, so it must not report success.
 *
 * `gate.surface` records which human gate was exercised — `ready` and `review`
 * are the publication gates whose workspaces resolve on their own, so the probe
 * also reads back the choice those components actually received.
 *
 * Top-level `return` + IIFE: Prettier accepts it (`allowReturnOutsideFunction`)
 * and `cdp.mjs` stmtForm fallback returns the value.
 */
return (async () => {
  const waitFor = async (predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  const detail = document.querySelector('run-detail');
  const root = detail?.shadowRoot;
  if (!root) return { ok: false, error: 'run-detail did not render on this route' };

  const panel = await waitFor(() => root.querySelector('[data-testid="run-posture"]'));
  if (!panel) {
    return {
      ok: false,
      error: 'no resource-posture panel rendered on Run Detail',
      runId: detail.run?.id ?? null,
    };
  }

  const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  const postureError = root.querySelector('[data-testid="run-posture-error"]');
  if (postureError) {
    return {
      ok: false,
      runId: detail.run?.id ?? null,
      error: `posture status is unreadable: ${text(postureError)}`,
    };
  }

  const summary = {
    posture: panel.dataset.posture ?? null,
    policySource: panel.dataset.policySource ?? null,
    counts: {
      retained: Number(panel.dataset.retainedCount),
      warm: Number(panel.dataset.warmCount),
      stopped: Number(panel.dataset.stoppedCount),
      failed: Number(panel.dataset.failedCount),
    },
    name: text(root.querySelector('[data-testid="run-posture-name"]')),
    source: text(root.querySelector('[data-testid="run-posture-source"]')),
    countsText: text(root.querySelector('[data-testid="run-posture-counts"]')),
    worker: text(root.querySelector('[data-testid="run-posture-worker"]')),
    lastTransition: text(root.querySelector('[data-testid="run-posture-transition"]')),
    effects: text(root.querySelector('[data-testid="run-posture-effects"]')),
    rejection: text(root.querySelector('[data-testid="run-posture-rejection"]')),
  };

  const rows = [...root.querySelectorAll('[data-testid^="run-posture-row-"]')].map((node) => ({
    capabilityId: node.dataset.testid.replace('run-posture-row-', ''),
    desiredDisposition: node.dataset.desired ?? null,
    observedState: node.dataset.observed ?? null,
    rowStatus: node.dataset.rowStatus ?? null,
    text: text(node),
  }));

  // Desired disposition and observed state must be two separate readings; a row
  // that renders only one of them cannot answer "is it actually running".
  const rowsCarryBothStates =
    rows.length === 0 || rows.every((row) => row.desiredDisposition && row.observedState);

  /**
   * Click a choice and wait for the Gateway's answer to land. Waiting only for
   * "a summary exists" is not enough: the previous choice's summary is still on
   * screen for the first frames, and reading it would report the wrong plan.
   */
  const selectChoice = async (gateBlock, choice) => {
    const button = gateBlock.querySelector(`[data-testid="run-posture-choice-${choice}"]`);
    if (!button) return { clicked: false };
    button.click();
    await waitFor(
      () =>
        root.querySelector('[data-testid="run-posture-preview-loading"]') ??
        root.querySelector('[data-testid="run-posture-preview-error"]'),
      20000,
    );
    const settled = await waitFor(
      () =>
        !root.querySelector('[data-testid="run-posture-preview-loading"]') &&
        (root.querySelector('[data-testid="run-posture-preview-summary"]') ??
          root.querySelector('[data-testid="run-posture-preview-error"]')),
      20000,
    );
    return {
      clicked: true,
      settled: Boolean(settled),
      summary: text(root.querySelector('[data-testid="run-posture-preview-summary"]')),
      error: text(root.querySelector('[data-testid="run-posture-preview-error"]')),
      rejection: text(root.querySelector('[data-testid="run-posture-preview-rejection"]')),
      lines: [...root.querySelectorAll('[data-testid^="run-posture-preview-"]')]
        .filter((node) =>
          /run-posture-preview-(acquire|retain|warm|stop)-/.test(node.dataset.testid),
        )
        .map((node) => text(node)),
    };
  };

  const gate = { present: false, skipped: null };
  const gateBlock = root.querySelector('[data-testid="run-posture-gate"]');
  if (!gateBlock) {
    const pending = (detail.run?.decisions ?? []).filter((decision) => !decision.resolvedAt);
    gate.skipped = pending.length
      ? `run has ${pending.length} unresolved decision(s) of type ${pending
          .map((decision) => decision.type)
          .join(', ')}, none of which renders posture choices`
      : 'run has no unresolved decision, so no human gate is waiting';
  } else {
    gate.present = true;
    gate.choices = [...gateBlock.querySelectorAll('[data-testid^="run-posture-choice-"]')].map(
      (node) => node.dataset.testid.replace('run-posture-choice-', ''),
    );
    // Drive the real operator path: click the choice, then read the plan the
    // Gateway sent back. `minimize` is the choice whose whole point is shedding
    // providers at a wait.
    const minimize = await selectChoice(gateBlock, 'minimize');
    if (!minimize.clicked) {
      gate.skipped = 'the minimize choice was not offered';
    } else {
      gate.previewSettled = minimize.settled;
      gate.previewSummary = minimize.summary;
      gate.previewError = minimize.error;
      gate.previewRejection = minimize.rejection;
      gate.previewLines = minimize.lines;

      // free-slot is defined by ADR-054 to be rejected until a run is park
      // eligible. Its verdict is a result to record, not an error to hide.
      const freeSlot = await selectChoice(gateBlock, 'free-slot');
      if (freeSlot.clicked) {
        gate.freeSlot = {
          settled: freeSlot.settled,
          summary: freeSlot.summary,
          error: freeSlot.error,
          rejection: freeSlot.rejection,
        };
        // Leave the gate as we found it so the probe cannot strand an operator
        // choice on a run it did not resolve.
        gateBlock.querySelector('[data-testid="run-posture-choice-free-slot"]')?.click();
      }
    }
  }

  const gateProved = gate.present
    ? Boolean(gate.previewSettled && (gate.previewSummary || gate.previewRejection))
    : false;

  // Which gate surface this run exercised. The ready/review publication gates
  // mount their own workspace, so the selector sits above it there; the generic
  // and interactive-handoff gates render it inline.
  gate.surface = root.querySelector('ready-workspace')
    ? 'ready'
    : root.querySelector('review-workspace')
      ? 'review'
      : gate.present
        ? 'inline'
        : 'none';
  // The workspace gates resolve through their own component, so the choice has
  // to reach them as a property or it is never sent.
  const workspace = root.querySelector('ready-workspace') ?? root.querySelector('review-workspace');
  if (workspace) {
    gate.workspaceReceivesChoice = workspace.resourcePosture ?? null;
    gate.workspaceBlockedReason = workspace.postureBlockedReason ?? null;
  }

  return {
    // `ok` requires the gate proof: a run whose posture panel renders but whose
    // gate was never exercised has not proved the deliverable.
    ok: Boolean(
      summary.posture &&
      summary.policySource &&
      rowsCarryBothStates &&
      rows.length > 0 &&
      gateProved,
    ),
    // Set by the caller before the probe runs. Read from a page dataset this
    // build never populates, it was silently null in every capture.
    testedSha: window.__farmslotProbeSha ?? null,
    runId: detail.run?.id ?? null,
    slotId: detail.run?.slotId ?? null,
    capturedAt: new Date().toISOString(),
    summary,
    rows,
    rowsCarryBothStates,
    gate,
    gateProved,
  };
})();
