const view = document.querySelector('fleet-canvas');
if (!view?.shadowRoot) return { mounted: false };
const url = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname === '/src/state.ts')
  .at(-1);
if (!url) throw new Error('The application state module did not load');
const module = await import(url);
const state = module.getState();
if (Reflect.get(view, 'fleetObservation') !== state.fleetObservation)
  throw new Error('Inspect the canonical observation owning the rendered fleet');
const cards = [...view.shadowRoot.querySelectorAll('machine-group')].flatMap((group) => [
  ...(group.shadowRoot?.querySelectorAll('slot-card') ?? []),
]);
return {
  mounted: true,
  visibility: document.visibilityState,
  connection: state.connection,
  freshness: state.fleetObservation.status,
  observedAt: state.fleetObservation.observedAt,
  resourceState: state.fleetObservation.resourceState,
  current: module.isFleetCurrent(),
  slots: cards.map((card) => ({
    id: card.slotData?.slot,
    lifecycle: card.slotData?.lifecycle,
    canonical: state.fleet?.slots.includes(card.slotData),
    rendered: Boolean(
      card.getClientRects().length && card.shadowRoot?.textContent.includes(card.slotData?.slot),
    ),
  })),
  stale: view.shadowRoot.querySelector('[data-fleet-freshness="stale"]')?.textContent?.trim(),
  refreshDisabled: view.shadowRoot.querySelector('.fleet-refresh-trigger')?.disabled,
  error: view.shadowRoot.querySelector('[role="alert"]')?.textContent?.trim(),
  storage: (await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics())
    ?.storage,
};
