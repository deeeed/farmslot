const view = document.querySelector('slot-view');
const panel = view?.querySelector('runtime-capabilities-panel');
if (!panel?.shadowRoot) return { mounted: false };
const url = performance
  .getEntriesByType('resource')
  .map(({ name }) => name)
  .filter((name) => new URL(name).pathname === '/src/resource-cache.ts')
  .at(-1);
if (!url) throw new Error('Inspect the active resource cache');
const cache = (await import(url)).getResourceCache();
const query = Reflect.get(panel.query, 'query');
if (!query || cache?.read(query) !== panel.query.state)
  throw new Error('Inspect the canonical capability query owning the rendered panel');
const notice = panel.shadowRoot.querySelector('[data-capability-freshness="stale"]');
const bounds = notice?.getBoundingClientRect();
const overlay = view.querySelector('.sv-recovery-overlay')?.getBoundingClientRect();
const unobscured = Boolean(
  bounds &&
  bounds.width > 0 &&
  bounds.height > 0 &&
  bounds.bottom > 0 &&
  bounds.top < innerHeight &&
  (!overlay ||
    bounds.right <= overlay.left ||
    bounds.left >= overlay.right ||
    bounds.bottom <= overlay.top ||
    bounds.top >= overlay.bottom),
);
return {
  mounted: true,
  unobscured,
  commandsInert: Boolean(panel.closest('[inert]')),
  canonical: panel.status === panel.query.state.data,
  query: { id: query.id, params: query.params },
  freshness: panel.query.state.status,
  observedAt: panel.query.state.observedAt,
  resourceState: panel.query.state.resourceState,
  ready: panel.query.ready,
  error: panel.error,
  actionError: panel.actionError,
  stale: panel.shadowRoot.querySelector('[data-capability-freshness="stale"]')?.textContent?.trim(),
  rows: [...panel.shadowRoot.querySelectorAll('[data-capability-id]')].map((row) => ({
    id: row.dataset.capabilityId,
    state: row.dataset.capabilityState,
    text: row.textContent.trim(),
    rendered: Boolean(row.getClientRects().length),
  })),
  leases: panel.status?.leases.map(({ id, capabilityId, state, owner }) => ({
    id,
    capabilityId,
    state,
    owner,
  })),
  buttons: [...panel.shadowRoot.querySelectorAll('button[data-testid]')].map((button) => ({
    id: button.dataset.testid,
    disabled: button.disabled,
    text: button.textContent.trim(),
  })),
  errorRendered: Boolean(
    panel.error &&
    panel.shadowRoot.querySelector('[role="alert"]')?.textContent.includes(panel.error),
  ),
};
