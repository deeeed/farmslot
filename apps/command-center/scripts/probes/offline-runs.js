const inbox = document.querySelector('decision-inbox');
if (!inbox?.shadowRoot) return { mounted: false, url: location.href };
const url = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname === '/src/state.ts')
  .at(-1);
const state = url
  ? (await import(url)).getState()
  : {
      decisionsObservation: Reflect.get(inbox, '_observation'),
      decisions: Reflect.get(inbox, '_decisions'),
      runsObservation: document.querySelector('run-list')?.runsObservation,
      runs: document.querySelector('run-list')?.runs ?? [],
      connection: document.querySelector('farm-app')?.connection,
    };
const storage = (
  await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics()
)?.storage;
if (state.decisionsObservation !== Reflect.get(inbox, '_observation'))
  throw new Error('The probe must read the module instance owning the rendered inbox');
const root = inbox.shadowRoot;
return {
  mounted: true,
  url: location.href,
  visibility: document.visibilityState,
  freshness: state.decisionsObservation.status,
  observedAt: state.decisionsObservation.observedAt,
  runFreshness: state.runsObservation?.status,
  runCount: state.runs.length,
  connection: state.connection,
  stale: root.querySelector('[data-freshness="stale"]')?.textContent?.trim(),
  rows: state.decisions.map((decision) => {
    const button = root.querySelector(`[data-decision-id="${CSS.escape(decision.id)}"]`);
    return {
      id: decision.id,
      title: decision.title,
      rendered: Boolean(
        button?.getClientRects().length &&
        button?.closest('.decision')?.textContent?.includes(decision.title),
      ),
      disabled: button?.disabled,
      rectangles: button?.getClientRects().length,
      error: root
        .querySelector(`[data-decision-error="${CSS.escape(decision.id)}"]`)
        ?.textContent?.trim(),
    };
  }),
  storage,
};
