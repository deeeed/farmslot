// Read this runtime's slot workspace, editor, drafts and connection. Never changes client state.
// An optional `PARAMS` prefix selects extra reads: `{ indexedDb: true, editorText: true }`.
const params = typeof PARAMS === 'undefined' ? {} : PARAMS;
function findAll(root, selector, found = []) {
  found.push(...root.querySelectorAll(selector));
  for (const node of root.querySelectorAll('*'))
    if (node.shadowRoot) findAll(node.shadowRoot, selector, found);
  return found;
}
const find = (selector) => findAll(document, selector)[0];
const text = (element) => element?.textContent?.replace(/\s+/g, ' ').trim();
const data = (element) =>
  element ? { ...element.dataset, text: text(element)?.slice(0, 300) } : undefined;
const base = {
  timeOrigin: performance.timeOrigin,
  href: location.href,
  hash: location.hash,
  visibility: document.visibilityState,
  auth: Boolean(document.querySelector('.auth-card')),
};
// A long-lived dev page can fill the resource timing buffer before lazy modules load.
const entries = performance.getEntriesByType('resource').map(({ name }) => name);
const loaded = (suffix) => entries.filter((name) => new URL(name).pathname.endsWith(suffix)).at(-1);
const gatewayUrl = loaded('/src/gateway-client.ts');
if (!gatewayUrl) return { ...base, loaded: false };
const { gateway } = await import(gatewayUrl);

const view = find('slot-view');
const viewer = view && findAll(view.shadowRoot ?? view, 'code-viewer')[0];
const comments = view && findAll(view.shadowRoot ?? view, 'pr-comments-panel')[0];
const editor = viewer?._editor;
const slot = view && {
  slotId: view.slotId,
  live: view._isLive,
  recoveryPhase: view._recoveryPhase,
  activeFile: view._activeFile,
  prNumber: view._prNumber,
  prRepo: view._prRepo,
  prThreads: (view._prThreads ?? []).map((thread) => ({
    path: thread.path,
    line: thread.line,
    bodies: thread.comments.map((comment) => comment.body),
  })),
  branchDiffBase: view._branchDiffBase,
  branchDiffLoading: view._branchDiffLoading,
  branchDiffError: view._branchDiffError,
  branchDiffFiles: (view._branchDiffFiles ?? []).map((file) => file.path),
  commentsText: text(comments?.shadowRoot ?? comments)?.slice(0, 600),
  editor: viewer && {
    readOnly: viewer.readOnly,
    path: viewer.path ?? viewer.filePath,
    ...(params.editorText && editor ? { value: editor.getValue() } : {}),
  },
  // The editing hooks agreed with the editor's authors; absent until that UI ships.
  readOnlyReason: data(find('[data-testid="editor-read-only"]')),
  saveButton: (() => {
    const button = find('[data-testid="file-save"]');
    return button && { disabled: button.disabled, text: text(button) };
  })(),
  saveState: data(find('[data-testid="file-save-state"]')),
  reviewWarning: data(find('[data-testid="save-review-warning"]')),
  changedNotice: data(find('[data-testid="file-changed-notice"]')),
  conflict: find('[data-testid="draft-conflict"]') && {
    mine: text(find('[data-testid="draft-conflict-mine"]')),
    theirs: text(find('[data-testid="draft-conflict-theirs"]')),
  },
};
const drafts = findAll(document, '[data-testid="draft-item"]').map((item) => ({
  ...item.dataset,
  text: text(item)?.slice(0, 200),
  copy: Boolean(item.querySelector('[data-testid="draft-copy"]')),
  discard: Boolean(item.querySelector('[data-testid="draft-discard"]')),
}));

// Every IndexedDB database and store this origin holds: the drafts store's real rows.
let indexedDb;
if (params.indexedDb) {
  indexedDb = [];
  for (const { name, version } of await indexedDB.databases()) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = {};
      for (const store of db.objectStoreNames)
        stores[store] = await new Promise((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      indexedDb.push({ name, version, stores });
    } finally {
      db.close();
    }
  }
}

return {
  ...base,
  loaded: true,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  principalId: gateway.authenticatedPrincipalId,
  capabilities: gateway.authenticatedConnection?.capabilities,
  slot,
  drafts,
  signOutDrafts: data(find('[data-testid="account-sign-out-drafts"]')),
  draftsDeletedNotice: data(find('[data-testid="drafts-deleted-notice"]')),
  ...(indexedDb ? { indexedDb } : {}),
};
