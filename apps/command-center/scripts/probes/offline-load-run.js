const slot = document.querySelector('slot-view');
const modal = slot?.renderRoot?.querySelector('slot-load-run-modal');
const controller = modal && Reflect.get(modal, 'runsQuery');
if (!modal?.shadowRoot || !controller) return { mounted: false, url: location.href };
const query = Reflect.get(controller, 'query');
const cacheUrl = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname === '/src/resource-cache.ts')
  .at(-1);
if (!cacheUrl) throw new Error('The current resource cache module did not load');
const cache = (await import(cacheUrl)).getResourceCache();
const observation = controller.state;
if (query && cache?.read(query) !== observation)
  throw new Error('Inspect the query owner rendering the actual load dialog');
const root = modal.shadowRoot;
return {
  mounted: true,
  url: location.href,
  documentStartedAt: performance.timeOrigin,
  open: modal.open,
  contextBlocked: modal.disabled,
  slotId: modal.slotId,
  project: modal.project,
  query: query && { id: query.id, method: query.method, params: query.params },
  status: observation.status,
  observedAt: observation.observedAt,
  rowsMatchCanonical: Reflect.get(modal, '_runs') === observation.data?.runs,
  rows: [...root.querySelectorAll('[data-run-id]')].map((row) => ({
    id: row.getAttribute('data-run-id'),
    visible: Boolean(row.getClientRects().length),
    text: row.textContent?.trim(),
    disabled: row.querySelector('.slrm-load')?.disabled,
  })),
  stale: root.querySelector('[data-load-run-freshness]')?.textContent?.trim(),
  pendingConfirm: Reflect.get(modal, '_pendingConfirm'),
  busy: Reflect.get(modal, '_actionBusy'),
  actionError: Reflect.get(modal, '_actionError'),
  prepare: Reflect.get(modal, '_prepareState'),
  storage: (await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics())
    ?.storage,
};
