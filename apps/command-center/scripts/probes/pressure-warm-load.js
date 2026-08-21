// Warm-load pressure history probe (MANUAL-000109).
//
// Run AFTER a fresh page reload, e.g.:
//   node scripts/cdp.mjs eval fleet "location.reload()"   # then wait ~2s
//   node scripts/cdp.mjs eval fleet --file probes/pressure-warm-load.js
//
// Observes the REAL intermediate DOM while fleet-canvas enters the resource
// view: the fast resource.pressure.history read should paint pressure cards
// (with freshness provenance) before the full snapshot and the per-slot
// resource batches finish. No state injection, no artificial client delays —
// the probe only polls the rendered shadow DOM and records timings.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canvas() {
  const shell = document.querySelector('app-shell')?.shadowRoot ?? document;
  return (
    shell.querySelector('fleet-canvas')?.shadowRoot ??
    document.querySelector('fleet-canvas')?.shadowRoot ??
    null
  );
}

function overview(root) {
  return root?.querySelector('machine-pressure-overview')?.shadowRoot ?? null;
}

function overviewState(root) {
  const view = overview(root);
  if (!view) return { previewCards: 0, fullCards: 0 };
  const sections = [...view.querySelectorAll('section.machine')];
  const previewCards = sections.filter((section) =>
    /attribution and details loading/.test(section.textContent),
  ).length;
  return { previewCards, fullCards: sections.length - previewCards };
}

if (!location.hash.startsWith('#fleet')) location.hash = '#fleet';
await sleep(100);
const root = await (async () => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = canvas();
    if (found) return found;
    await sleep(100);
  }
  throw new Error('fleet-canvas not found');
})();

// Enter the resource view through the real toolbar control so the fetch path
// is exactly what an operator triggers.
const resourceToggle = [...root.querySelectorAll('button.toggle-btn')].find(
  (button) => button.textContent.trim().toLowerCase() === 'resource',
);
if (!resourceToggle) throw new Error('resource view toggle not found');
const t0 = performance.now();
resourceToggle.click();

let previewPaintMs = null;
let previewObserved = null;
let fullSnapshotMs = null;
let detailsDoneMs = null;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const state = overviewState(root);
  if (previewPaintMs === null && state.previewCards > 0) {
    previewPaintMs = Math.round(performance.now() - t0);
    const view = overview(root);
    previewObserved = {
      previewCards: state.previewCards,
      freshnessLabels: [
        ...(view?.querySelectorAll('[data-testid="pressure-history-freshness"]') ?? []),
      ].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
    };
  }
  if (fullSnapshotMs === null && state.fullCards > 0) {
    fullSnapshotMs = Math.round(performance.now() - t0);
  }
  const detailsLoading = [...root.querySelectorAll('div.empty')].some((el) =>
    /Resource details loading/.test(el.textContent),
  );
  if (detailsDoneMs === null && fullSnapshotMs !== null && !detailsLoading) {
    detailsDoneMs = Math.round(performance.now() - t0);
  }
  if (previewPaintMs !== null && fullSnapshotMs !== null && detailsDoneMs !== null) break;
  await sleep(50);
}

return {
  previewPaintMs,
  previewObserved,
  fullSnapshotMs,
  detailsDoneMs,
  previewPaintedBeforeFullSnapshot:
    previewPaintMs !== null && fullSnapshotMs !== null && previewPaintMs < fullSnapshotMs,
};
