// On a connected #roadmap route containing delivered work:
// node scripts/cdp.mjs eval roadmap --file scripts/probes/roadmap-delivery-outcomes.js
// Drives filter buttons and checks rendered rows against the gateway projection.
const root = document.querySelector('roadmap-panel')?.shadowRoot;
if (!root) throw new Error('Roadmap panel unavailable');
// Reuse the loaded module, including Vite's HMR version, instead of a second client.
const gatewayModule = performance
  .getEntriesByType('resource')
  .findLast((entry) => entry.name.startsWith(`${location.origin}/src/gateway-client.ts`))?.name;
if (!gatewayModule) throw new Error('Gateway client module unavailable');
const { gateway } = await import(gatewayModule);
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Roadmap outcome view did not settle');
};
const choose = async (filter) => {
  root.querySelector(`[data-testid="roadmap-filter-delivery-${filter}"]`).click();
  await waitFor(() =>
    root.querySelector(`[data-testid="roadmap-filter-delivery-${filter}"].active`),
  );
};
await choose('delivered');
await waitFor(() => root.querySelector('[data-testid="roadmap-delivered-pr-link"]'));
if (root.querySelector('[data-testid="roadmap-undelivered-group"]')) {
  throw new Error('Delivered filter still shows active work');
}
const delivered = [];
for (const row of root.querySelectorAll('details [data-row-id]')) {
  const id = row.dataset.rowId;
  const { delivery } = await gateway.request('roadmap.get', { itemId: id });
  if (delivery?.status !== 'delivered') throw new Error(`${id} is not projected delivered`);
  const links = [...row.querySelectorAll('[data-testid="roadmap-delivered-pr-link"]')];
  for (const pr of delivery.prs.filter((pr) => pr.url)) {
    if (!links.some((link) => link.href === pr.url && link.textContent === pr.ref)) {
      throw new Error(`${id} is missing projected PR ${pr.ref}`);
    }
  }
  delivered.push(id);
}
if (!delivered.length) throw new Error('Proof requires delivered work');
await choose('undelivered');
if (root.querySelector('details')) throw new Error('Undelivered filter still shows Delivered');
const active = [...root.querySelectorAll('[data-row-id]')];
if (active.some((row) => delivered.includes(row.dataset.rowId))) {
  throw new Error('Delivered work remains in the active list');
}
// Regression: hiding the expanded group, refreshing, then reopening must reload links.
const refresh = root.querySelector('[data-testid="roadmap-refresh"]');
refresh.click();
await document.querySelector('roadmap-panel').updateComplete;
await waitFor(() => !refresh.disabled);
await choose('delivered');
await waitFor(() => root.querySelector('[data-testid="roadmap-delivered-pr-link"]'));
await choose('all');
return { delivered, undelivered: active.length, projectionAndFilters: 'PASS' };
