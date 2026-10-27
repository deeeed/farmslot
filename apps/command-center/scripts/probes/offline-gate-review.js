// Read this runtime's gate view and its scoped SQLite rows. Never changes client state.
// An optional `PARAMS` prefix names content to verify and text to search for.
const params = typeof PARAMS === 'undefined' ? {} : PARAMS;
function find(root, selector) {
  const result = root.querySelector(selector);
  if (result) return result;
  for (const node of root.querySelectorAll('*'))
    if (node.shadowRoot) {
      const child = find(node.shadowRoot, selector);
      if (child) return child;
    }
}
// A long-lived dev page can fill the resource timing buffer before lazy modules load.
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
if (!ownerUrl || !gatewayUrl) return { ...base, loaded: false };
const { getResourceStoreMetadata, getResourceStoreNotice } = await import(ownerUrl);
const { gateway } = await import(gatewayUrl);
const { gitBlobHash } = await import(loaded('/packages/protocol/src/client-cache/index.ts'));
const text = (element) => element?.textContent?.replace(/\s+/g, ' ').trim();
const decoder = new TextDecoder();
const hex = async (data) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const scope = getResourceStoreMetadata()?.scope;
const notice = getResourceStoreNotice();
let persistent = false;
let store;
// A tab on memory storage never opens the store here: opening would take ownership if it were free.
if (scope && !/will not survive a restart/.test(notice ?? '')) {
  const { createBrowserSqliteResourceStore } = await import(
    loaded('/packages/local-store/src/browser.ts')
  );
  const opened = await createBrowserSqliteResourceStore({ scope });
  try {
    persistent = opened.persistent;
    const content = await opened.listContent();
    const queries = await opened.listQueries();
    const verified = [];
    for (const key of params.content ?? []) {
      const entry = await opened.getContent(key);
      verified.push({
        ...key,
        present: Boolean(entry),
        bytes: entry?.data.byteLength,
        origin: entry?.origin,
        cohort: entry?.cohort,
        blobHash: entry && key.kind === 'blob' ? gitBlobHash(entry.data) : undefined,
        sha256: entry && key.kind === 'artifact' ? await hex(entry.data) : undefined,
        ...(params.withText && entry ? { text: decoder.decode(entry.data) } : {}),
        ...(entry?.untrackedFiles ? { untrackedFiles: entry.untrackedFiles } : {}),
      });
    }
    const rows = {};
    for (const id of params.queries ?? []) rows[id] = (await opened.getQuery(id)) ?? null;
    // Search every stored row and every held byte for forbidden needles.
    const hits = [];
    if (params.scan?.length) {
      for (const info of queries) {
        const row = await opened.getQuery(info.id);
        const body = JSON.stringify(row);
        for (const needle of params.scan)
          if (body.includes(needle)) hits.push({ table: 'query', id: info.id, needle });
      }
      for (const info of content) {
        const entry = await opened.getContent(info);
        const body = decoder.decode(entry.data) + JSON.stringify(entry.untrackedFiles ?? []);
        for (const needle of params.scan)
          if (body.includes(needle))
            hits.push({ table: 'content', kind: info.kind, id: info.id, needle });
      }
    }
    store = {
      content: content.map(({ kind, id, bytes, origin, cohort }) => ({
        kind,
        id,
        bytes,
        origin,
        cohort,
      })),
      queries: queries.map(({ id }) => id),
      verified,
      rows,
      hits,
    };
  } finally {
    await opened.close();
  }
}

const detail = find(document, 'run-detail');
const workspace = detail && find(detail.shadowRoot ?? detail, 'ready-workspace');
const diff = workspace?.querySelector('diff-review');
return {
  ...base,
  loaded: true,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  principalId: gateway.authenticatedPrincipalId,
  batchedContent: gateway.authenticatedConnection?.capabilities?.batchedContent,
  scope,
  persistent,
  notice,
  store,
  gate: detail && {
    header: text(detail.shadowRoot?.querySelector('.run-header, header, h1, h2'))?.slice(0, 200),
    detailText: text(detail.shadowRoot ?? detail)?.slice(0, 1200),
    workspace: Boolean(workspace),
    tabs: workspace
      ? [...workspace.querySelectorAll('button.rdy-tab')].map((button) => ({
          label: text(button),
          active: button.classList.contains('active'),
        }))
      : [],
    diffTable: Boolean(diff?.querySelector('.d2h-diff-table')),
    diffFiles: workspace
      ? [...workspace.querySelectorAll('.d2h-file-name, .dr-filename')].map(text)
      : [],
    diffText: text(diff?.querySelector('.d2h-diff-table'))?.slice(0, 400),
    images: workspace
      ? [...workspace.querySelectorAll('img')].map((image) => ({
          src: image.src.slice(0, 40),
          complete: image.complete,
          width: image.naturalWidth,
          height: image.naturalHeight,
        }))
      : [],
  },
};
