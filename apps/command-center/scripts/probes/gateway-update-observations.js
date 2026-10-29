// Read only this application's current observation and its scoped SQLite value.
const app = document.querySelector('farm-app');
if (!app) return { mounted: false };
await app.updateComplete;
const controller = Reflect.get(app, 'updateQuery');
const query = controller && Reflect.get(controller, 'query');
if (!query) return { mounted: true, queryBound: false };
const loaded = (pathname) =>
  performance
    .getEntriesByType('resource')
    .map(({ name }) => name)
    .filter((name) => new URL(name).pathname === pathname)
    .at(-1);
const ownerUrl = loaded('/src/resource-cache.ts');
if (!ownerUrl) return { mounted: true, ownerLoaded: false };
const { getResourceCache, getResourceStoreMetadata } = await import(ownerUrl);
const gatewayUrl = loaded('/src/gateway-client.ts');
const { gateway } = await import(gatewayUrl);
const cache = getResourceCache();
const state = controller.state;
const scope = getResourceStoreMetadata()?.scope;
let stored;
let persistent = false;
if (scope) {
  const { createBrowserSqliteResourceStore, browserResourceStoreDiagnostics } = await import(
    performance
      .getEntriesByType('resource')
      .map(({ name }) => name)
      .filter((name) => new URL(name).pathname.endsWith('/packages/local-store/src/browser.ts'))
      .at(-1)
  );
  const store = await createBrowserSqliteResourceStore({ scope });
  try {
    persistent = store.persistent;
    stored = await store.getQuery(query.id);
  } finally {
    await store.close();
  }
  if (persistent && (await browserResourceStoreDiagnostics()).integrity !== 'ok')
    throw new Error('Actual browser SQLite integrity failed');
}
const text = (element) => element?.textContent?.replace(/\s+/g, ' ').trim();
const root = app.renderRoot;
const banner = root.querySelector('update-banner');
return {
  mounted: true,
  queryBound: true,
  timeOrigin: performance.timeOrigin,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  collectorMethods:
    gateway.authenticatedConnection?.capabilities?.resourceChanges?.upstreamObservers?.methods,
  canonical: controller.belongsToWorkspace && cache?.read(query) === state,
  ready: controller.ready,
  status: state.status,
  data: state.data,
  observedAt: state.observedAt,
  sourceObservation: state.sourceObservation,
  resourceState: state.resourceState,
  error: state.error,
  persistent,
  stored,
  scope,
  footer: text(root.querySelector('.fa-version-footer')),
  banner: text(banner?.shadowRoot),
  modal: text(root.querySelector('.fa-version-modal')),
  recheckButtons: [...root.querySelectorAll('.fa-version-actions button')].map((button) => ({
    text: text(button),
    disabled: button.disabled,
  })),
};
