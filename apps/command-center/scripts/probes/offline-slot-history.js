const modal = document.querySelector('slot-view')?.renderRoot?.querySelector('slot-history-modal');
const controller = modal && Reflect.get(modal, 'historyQuery');
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
  throw new Error('Inspect the canonical history observation rendering this dialog');
const root = modal.shadowRoot;
return {
  mounted: true,
  open: modal.open,
  contextBlocked: modal.disabled,
  slotId: modal.slotId,
  query: query && { id: query.id, method: query.method, params: query.params },
  status: observation.status,
  observedAt: observation.observedAt,
  rowsMatchCanonical: Reflect.get(modal, '_runs') === observation.data?.runs,
  slotExists: observation.data?.slotExists,
  error: observation.error?.message,
  stale: root.querySelector('[data-history-freshness]')?.textContent?.trim(),
  rows: [...root.querySelectorAll('[data-run-id]')].map((row) => {
    const prepare = row.querySelector('slot-prepare-popover');
    return {
      id: row.getAttribute('data-run-id'),
      visible: Boolean(row.getClientRects().length),
      text: row.textContent?.trim(),
      current: Boolean(row.querySelector('.shm-current')),
      prepareDisabled: prepare?.shadowRoot?.querySelector('.spp-trigger')?.disabled,
      confirming: prepare && Reflect.get(prepare, '_open'),
      busy: prepare && Reflect.get(prepare, '_busy'),
      actionError: prepare && Reflect.get(prepare, '_error'),
    };
  }),
};
