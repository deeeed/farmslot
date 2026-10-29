// Read only this runtime's mounted upstream collector panels and their scoped SQLite rows.
function find(root, tag) {
  const result = root.querySelector(tag);
  if (result) return result;
  for (const node of root.querySelectorAll('*'))
    if (node.shadowRoot) {
      const child = find(node.shadowRoot, tag);
      if (child) return child;
    }
}
// A long-lived dev page can fill the resource timing buffer before lazy modules load. Their URL is
// then derived from an early module of the same workspace, so the import is the app's own instance.
const entries = performance.getEntriesByType('resource').map(({ name }) => name);
const loaded = (suffix) => {
  const seen = entries.filter((name) => new URL(name).pathname.endsWith(suffix)).at(-1);
  if (seen || !suffix.startsWith('/packages/')) return seen;
  const sibling = entries.find((name) =>
    new URL(name).pathname.includes('/packages/protocol/src/'),
  );
  return (
    sibling && new URL(sibling.slice(0, sibling.indexOf('/packages/protocol/src/')) + suffix).href
  );
};
const base = {
  timeOrigin: performance.timeOrigin,
  href: location.href,
  hash: location.hash,
  visibility: document.visibilityState,
  auth: Boolean(document.querySelector('.auth-card')),
};
const ownerUrl = loaded('/src/resource-cache.ts');
const gatewayUrl = loaded('/src/gateway-client.ts');
const protocolUrl = loaded('/packages/protocol/src/client-cache/index.ts');
if (!ownerUrl || !gatewayUrl || !protocolUrl) return { ...base, loaded: false };
const { getResourceCache, getResourceStoreMetadata } = await import(ownerUrl);
const { gateway } = await import(gatewayUrl);
const { resourceQuery } = await import(protocolUrl);
const cache = getResourceCache();
const text = (element) => element?.textContent?.replace(/\s+/g, ' ').trim();
const visible = (element) => Boolean(element && element.getClientRects().length);
const queries = {
  accounts: resourceQuery('config.githubAccounts'),
  prDetail: resourceQuery('pr.status', { pr: 7, project: 'upstream-proof' }),
  seats: resourceQuery('providerAccounts.snapshot'),
  prList: resourceQuery('pr.list'),
};
function observe(controller, expected) {
  const query = controller && Reflect.get(controller, 'query');
  if (!query) return undefined;
  if (query.id !== expected.id) throw new Error('Mounted reader names another query: ' + query.id);
  const state = controller.state;
  return {
    id: query.id,
    canonical: Boolean(cache) && controller.belongsToWorkspace && cache.read(query) === state,
    ready: controller.ready,
    status: state.status,
    data: state.data,
    observedAt: state.observedAt,
    sourceObservation: state.sourceObservation,
    error: state.error,
  };
}
const board = find(document, 'pr-board');
const automation = board && find(board.shadowRoot, 'pr-automation-panel');
const picker = automation && find(automation.shadowRoot, 'pr-github-account-picker');
const fleet = find(document, 'fleet-canvas');
const group = fleet && find(fleet.shadowRoot, 'machine-group');
const modal = group?.shadowRoot.querySelector('[data-testid="machine-accounts-panel"]');
const detail = board?.shadowRoot.querySelector('.split-detail');
const scope = getResourceStoreMetadata()?.scope;
let persistent = false;
const stored = {};
if (scope) {
  const { createBrowserSqliteResourceStore, browserResourceStoreDiagnostics } = await import(
    loaded('/packages/local-store/src/browser.ts')
  );
  const store = await createBrowserSqliteResourceStore({ scope });
  try {
    persistent = store.persistent;
    for (const [name, query] of Object.entries(queries))
      stored[name] = (await store.getQuery(query.id)) ?? null;
  } finally {
    await store.close();
  }
  if (persistent && (await browserResourceStoreDiagnostics()).integrity !== 'ok')
    throw new Error('Actual browser SQLite integrity failed');
}
return {
  ...base,
  loaded: true,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  principalId: gateway.authenticatedPrincipalId,
  collectorMethods:
    gateway.authenticatedConnection?.capabilities?.resourceChanges?.upstreamObservers?.methods,
  scope,
  persistent,
  stored,
  accounts: automation
    ? observe(
        Reflect.get(Reflect.get(automation, 'controller'), 'accountResources'),
        queries.accounts,
      )
    : undefined,
  prDetail: board ? observe(Reflect.get(board, '_detailQuery'), queries.prDetail) : undefined,
  seats: fleet ? observe(Reflect.get(fleet, 'providerAccountsQuery'), queries.seats) : undefined,
  // The board reads the dashboard list through the application's shared prsQuery.
  prList: (() => {
    const state = board && cache?.read(queries.prList);
    return (
      state && {
        status: state.status,
        observedAt: state.observedAt,
        sourceObservation: state.sourceObservation,
        rows: state.data?.prs.map(({ pr, repo, title, ownedFamily }) => ({
          pr,
          repo,
          title,
          ownedFamily,
        })),
        data: state.data,
      }
    );
  })(),
  board: board && {
    count: text(board.shadowRoot.querySelector('[data-testid="pr-board-count"]')),
    banner: text(board.shadowRoot.querySelector('.rehydrating-banner')),
    card: (() => {
      const cards = [...board.shadowRoot.querySelectorAll('pr-card')];
      const card =
        cards.find((item) => item.closest('.split-detail')) ??
        cards.find((item) => item.forceExpanded);
      return text(card?.shadowRoot)?.slice(0, 600);
    })(),
  },
  picker: picker && {
    visible: visible(picker),
    text: text(picker.shadowRoot),
    accounts: [...picker.shadowRoot.querySelectorAll('[data-account-login]')].map(
      (element) => element.dataset.accountLogin,
    ),
    error: text(picker.shadowRoot.querySelector('.error')),
    refresh: [
      ...picker.shadowRoot.querySelectorAll('[data-testid="pr-github-accounts-refresh"]'),
    ].map((button) => ({ disabled: button.disabled, visible: visible(button) })),
  },
  detail: detail && {
    text: text(detail).slice(0, 600),
    title: text(detail.querySelector('h2, h3, .detail-title')),
  },
  checkGitHub: board
    ? [...board.shadowRoot.querySelectorAll('button')]
        .filter((button) => text(button) === 'Check GitHub')
        .map((button) => ({ disabled: button.disabled }))
    : undefined,
  setup: group && {
    button: [...group.shadowRoot.querySelectorAll('[data-testid="machine-accounts-btn"]')].map(
      (button) => ({ disabled: button.disabled, visible: visible(button) }),
    ),
    open: visible(modal),
    text: text(modal)?.slice(0, 900),
    age: text(modal?.querySelector('.setup-age')),
    rows: [...(modal?.querySelectorAll('.setup-row') ?? [])].map((row) => ({
      runner: row.dataset.runner,
      text: text(row),
      title: row.querySelector('.setup-identity')?.title,
    })),
    refresh: [...(modal?.querySelectorAll('[data-testid="machine-accounts-refresh"]') ?? [])].map(
      (button) => ({ disabled: button.disabled }),
    ),
    retry: [...(modal?.querySelectorAll('button') ?? [])]
      .filter((button) => text(button) === 'Retry')
      .map((button) => ({ disabled: button.disabled })),
  },
};
