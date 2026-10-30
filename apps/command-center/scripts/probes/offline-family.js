const panel = document.querySelector('family-observability');
if (!panel?.shadowRoot) return { mounted: false };
const family = Reflect.get(panel, 'familyQuery')?.state;
const detail = Reflect.get(panel, 'fullRunQuery')?.state;
const text = panel.shadowRoot.textContent;
const snapshot = panel.snapshot;
const report = [...panel.shadowRoot.querySelectorAll('button')].find((button) =>
  /Generate family report/.test(button.textContent),
);
let storedObservedAt;
if (detail?.data?.run.id) {
  const url = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) =>
      new URL(name).pathname.endsWith('/packages/protocol/src/client-cache/index.ts'),
    )
    .at(-1);
  if (!url) throw new Error('The shared cache module did not load');
  const { resourceQuery } = await import(url);
  const { inspectResourceAuthority } = await import('/src/dev/resource-authority-proof.ts');
  storedObservedAt = (
    await inspectResourceAuthority(
      undefined,
      resourceQuery('run.get', { runId: detail.data.run.id }),
    )
  ).storedObservedAt;
}
const tray = document.querySelector('farm-notification-tray')?.shadowRoot;
const noticesClosed = tray?.querySelector('.bell')?.getAttribute('aria-expanded') === 'false';
const ids = [
  Reflect.get(Reflect.get(panel, 'familyQuery'), 'query')?.id,
  Reflect.get(Reflect.get(panel, 'fullRunQuery'), 'query')?.id,
].map((id) => `read:${id}`);
return {
  mounted: true,
  noticesClosed,
  readNoticesNeeded: family?.status === 'stale' || detail?.status === 'stale',
  hash: location.hash,
  selectionInRoute:
    new URLSearchParams(location.hash.split('?')[1] ?? '').get('run') === panel.selectedRunId,
  familyFreshness: family?.status,
  detailFreshness: detail?.status,
  observedAt: detail?.observedAt,
  storedObservedAt,
  fullRunId: detail?.data?.run.id,
  snapshotCanonical: Boolean(snapshot && snapshot === family?.data?.snapshot),
  workflowState: snapshot?.workflowState,
  workflowRendered: Boolean(snapshot && text.includes(snapshot.workflowState)),
  selectedRunId: panel.selectedRunId,
  runIds: snapshot?.runs.map(({ runId }) => runId) ?? [],
  reportDisabled: report?.disabled,
  saved: [...(tray?.querySelectorAll('[data-notice-id]') ?? [])]
    .filter((node) => ids.includes(node.getAttribute('data-notice-id')))
    .map((node) => node.textContent.trim()),
  savedRunLink: panel.shadowRoot
    .querySelector(`a[href="#run/${detail?.data?.run.id}"]`)
    ?.textContent.trim(),
  storage: (await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics())
    ?.storage,
};
