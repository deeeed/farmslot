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
const groups = [...view.shadowRoot.querySelectorAll('machine-group')];
const cards = groups.flatMap((group) => [
  ...(group.shadowRoot?.querySelectorAll('slot-card') ?? []),
]);
// The table draws one row per slot, found through its selection checkbox.
const rows = groups.flatMap((group) =>
  (group.slots ?? []).map((slot) => {
    const box = group.shadowRoot?.querySelector(
      `input[aria-label=${JSON.stringify(`Select ${slot.slot}`)}]`,
    );
    return { slot, box, row: box?.closest('tr') };
  }),
);
const shell = document.querySelector('farm-app');
return {
  mounted: true,
  visibility: document.visibilityState,
  connection: state.connection,
  freshness: state.fleetObservation.status,
  observedAt: state.fleetObservation.observedAt,
  resourceState: state.fleetObservation.resourceState,
  current: module.isFleetCurrent(),
  nodeFreshness: view.nodeQuery.state.status,
  nodeObservedAt: view.nodeQuery.state.observedAt,
  nodeResourceState: view.nodeQuery.state.resourceState,
  nodes: [...view.nodeInfo.values()],
  nodesCanonical: [...view.nodeInfo.values()].every((node) =>
    view.nodeQuery.state.data?.nodes.includes(node),
  ),
  nodeStale: view.shadowRoot.querySelector('[data-node-freshness="stale"]')?.textContent?.trim(),
  nodeBadges: [...view.shadowRoot.querySelectorAll('machine-group')].map((group) =>
    group.shadowRoot?.querySelector('.node-badge')?.textContent?.trim(),
  ),
  versionsOpen: shell?.versionDetailsOpen,
  versionsNodesCanonical: Boolean(
    shell?.versionDetailsNodes &&
    shell.versionDetailsNodes === view.nodeQuery.state.data &&
    shell.nodeQuery.state.data === view.nodeQuery.state.data,
  ),
  versionsRendered: shell?.querySelector('.fa-version-modal')?.textContent,
  view: cards.length ? 'card' : 'list',
  slots: cards.length
    ? cards.map((card) => ({
        id: card.slotData?.slot,
        lifecycle: card.slotData?.lifecycle,
        canonical: state.fleet?.slots.includes(card.slotData),
        rendered: Boolean(
          card.getClientRects().length &&
          card.shadowRoot?.textContent.includes(card.slotData?.slot),
        ),
      }))
    : rows.map(({ slot, box, row }) => ({
        id: slot.slot,
        lifecycle: slot.lifecycle,
        canonical: state.fleet?.slots.includes(slot),
        rendered: Boolean(row?.getClientRects().length),
        ticked: Boolean(box?.checked),
      })),
  stale: view.shadowRoot.querySelector('[data-fleet-freshness="stale"]')?.textContent?.trim(),
  refreshDisabled: view.shadowRoot.querySelector('.fleet-refresh-trigger')?.disabled,
  error: view.shadowRoot.querySelector('[role="alert"]')?.textContent?.trim(),
  storage: (await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics())
    ?.storage,
};
