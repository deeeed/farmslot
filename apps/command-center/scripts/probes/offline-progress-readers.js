// Read only. Navigation and controls belong to cdp.mjs.
const params = new URLSearchParams(location.search);
const slotId = params.get('progress-reader-slot');
const surface = params.get('progress-reader-surface');
if (!slotId || !['fleet', 'slot', 'terminal'].includes(surface))
  throw new Error('Select the owned slot and progress reader');
const moduleUrl = (pathname) =>
  performance
    .getEntriesByType('resource')
    .map(({ name }) => name)
    .filter((name) => new URL(name).pathname === pathname)
    .at(-1);
const cacheUrl = moduleUrl('/src/resource-cache.ts');
const gatewayUrl = moduleUrl('/src/gateway-client.ts');
if (!cacheUrl || !gatewayUrl) return { mounted: false, surface };
const cache = (await import(cacheUrl)).getResourceCache();
const { gateway } = await import(gatewayUrl);
const deep = (selector, root = document) => {
  const found = [...root.querySelectorAll(selector)];
  for (const node of root.querySelectorAll('*'))
    if (node.shadowRoot) found.push(...deep(selector, node.shadowRoot));
  return found;
};
let view;
let controller;
let rendered;
let canonical;
if (surface === 'fleet') {
  view = document.querySelector('fleet-canvas');
  controller = view && Reflect.get(view, 'progressQueries')?.get(slotId);
  const card = deep('slot-card').find((value) => value.slotData?.slot === slotId);
  rendered = Boolean(
    card?.getClientRects().length &&
    card.shadowRoot?.querySelector('.mini-progress')?.getClientRects().length,
  );
  canonical = Boolean(
    controller &&
    card?.progress === controller.state.data?.structured &&
    Reflect.get(view, 'progressObservations')?.get(slotId) === controller.state,
  );
} else if (surface === 'slot') {
  view = document.querySelector('slot-view');
  controller = view && Reflect.get(view, '_progressQuery');
  const displayed = view && Reflect.get(view, '_structuredProgress');
  // ADR-010's slot view uses light DOM; its task tracker owns its own shadow root.
  const tracker = view?.querySelector('.sv-task-panel-body progress-tracker');
  rendered = Boolean(tracker?.getClientRects().length);
  canonical = Boolean(
    controller &&
    displayed === controller.state.data?.structured &&
    tracker?.structured === displayed,
  );
} else {
  view = deep('terminal-view').find((value) => value.slotId === slotId);
  controller = view && Reflect.get(view, 'progressQuery');
  const tracker = view?.shadowRoot?.querySelector('.progress-strip progress-tracker');
  const displayed = view && Reflect.get(view, '_taskMarkdown');
  rendered = Boolean(tracker?.getClientRects().length);
  canonical = Boolean(
    controller && displayed === controller.state.data?.markdown && tracker?.markdown === displayed,
  );
}
const query = controller && Reflect.get(controller, 'query');
const state = controller?.state;
if (!view || !query || !cache || !controller.belongsToWorkspace)
  return { mounted: Boolean(view), surface, query: false, hash: location.hash };
if (cache.read(query) !== state)
  throw new Error('The mounted reader must use its canonical shared observation');
return {
  mounted: true,
  query: true,
  surface,
  hash: location.hash,
  slotId,
  runId: query.params.runId,
  params: query.params,
  queryId: query.id,
  canonical,
  rendered,
  freshness: state.status,
  observedAt: state.observedAt,
  resourceState: state.resourceState,
  completed: state.data?.structured?.completedSteps,
  total: state.data?.structured?.totalSteps,
  connectionId: gateway.resourceConnectionId,
  connectionState: gateway.connectionState,
};
