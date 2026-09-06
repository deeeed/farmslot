// CDP probe: Run Detail's resource-posture rows render the device a capability
// lease actually resolved to (ADR-054 item 3, MANUAL-000113).
//
// Scope, stated plainly: this proves RENDERING. It loads the shipped renderer
// module out of the running Vite dev server, hands it a `runtime.posture.status`
// payload, and asserts the DOM the app would paint. It does NOT prove the
// Gateway's derivation of `target` from a lease's parameters — that is
// `posture.test.ts` ("validation preparation on a new device...") and the live
// `device-retarget-smoke-driver.mjs` node, both of which read the real lease.
//
// The label is asserted as painted text, including the protocol's declared key
// order and separator, so a renderer that formatted the target its own way
// fails here rather than agreeing with itself.
//
// Run on any Command Center route, e.g.
//   node scripts/cdp.mjs eval slot/<slot-id> --file probes/run-posture-device-target-row.js

const host = document.createElement('div');
host.id = 'cdp-posture-device-target';
host.style.cssText = 'position:fixed;left:0;bottom:0;width:900px;z-index:2147483647;';
document.body.appendChild(host);

const result = { steps: [] };
function step(name, ok, evidence) {
  result.steps.push({ step: name, ok, evidence });
  if (!ok) result.failed = true;
}

try {
  const renderers = await import('/src/components/runs/run-detail-posture-renderers.ts');
  // Vite serves bare specifiers from its own optimized deps; ask it, not the
  // browser's bare-specifier resolver.
  const lit = await import('/node_modules/lit/index.js').catch(() => import('/@id/lit'));

  const capability = (overrides) => ({
    capabilityId: 'ios-simulator',
    desiredDisposition: 'acquired',
    observedState: 'running',
    policySource: 'framework-default',
    reason: 'required by the current proof plan',
    releaseEffects: ['The simulator is shut down'],
    ...overrides,
  });

  // What `runtime.posture.status` returns for a run that re-targeted, beside a
  // capability that takes no device at all.
  const state = {
    posture: 'active',
    policySource: 'framework-default',
    workerRetained: true,
    updatedAt: '2026-09-07T00:00:00.000Z',
    capabilities: [
      capability({ target: { simulator: 'playground-1' } }),
      capability({ capabilityId: 'browser-cdp', releaseEffects: ['Closes the CDP browser'] }),
    ],
  };

  const summary = renderers.summarizeRunPosture(state);
  step(
    'row-carries-the-resolved-target',
    summary.rows[0]?.targetLabel === 'simulator=playground-1' &&
      summary.rows[1]?.targetLabel === undefined,
    { device: summary.rows[0]?.targetLabel, nonDevice: summary.rows[1]?.targetLabel ?? null },
  );

  lit.render(renderers.renderRunPostureSummary({ status: 'ready', state }), host);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const targetCell = host.querySelector('[data-testid="run-posture-target-ios-simulator"]');
  const browserCell = host.querySelector('[data-testid="run-posture-target-browser-cdp"]');
  step(
    'target-is-painted-on-the-device-row-only',
    targetCell?.textContent?.trim() === 'target simulator=playground-1' && browserCell === null,
    {
      painted: targetCell?.textContent?.trim() ?? null,
      nonDeviceRowHasTarget: browserCell !== null,
    },
  );

  const row = host.querySelector('[data-testid="run-posture-row-ios-simulator"]');
  step('target-sits-inside-its-capability-row', Boolean(row) && row.contains(targetCell), {
    rowText: row?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) ?? null,
  });

  // A multi-key target keeps the protocol's declared key order and separator.
  // Asserted in the DOM rather than on the helper, so a renderer that formatted
  // the target its own way fails here.
  lit.render(
    renderers.renderRunPostureSummary({
      status: 'ready',
      state: {
        ...state,
        capabilities: [capability({ target: { udid: 'ABC-123', simulator: 'playground-1' } })],
      },
    }),
    host,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const multi = host.querySelector('[data-testid="run-posture-target-ios-simulator"]');
  step(
    'multi-key-target-keeps-the-protocol-key-order',
    multi?.textContent?.trim() === 'target udid=ABC-123, simulator=playground-1',
    { painted: multi?.textContent?.trim() ?? null },
  );

  result.ok = !result.failed;
  return result;
} finally {
  host.remove();
}
