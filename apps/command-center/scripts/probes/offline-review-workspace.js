const detail = document.querySelector('run-detail');
const views = [...(detail?.shadowRoot?.querySelectorAll('review-workspace') ?? [])];
const view = views.find((view) => !view.readOnly) ?? views[0];
if (!view) return { mounted: false, detail: Boolean(detail) };
const queries = view._queries;
const cacheUrl = performance
  .getEntriesByType('resource')
  .map(({ name }) => name)
  .filter((name) => new URL(name).pathname === '/src/resource-cache.ts')
  .at(-1);
if (!cacheUrl) throw new Error('Inspect the active resource cache');
const cache = (await import(cacheUrl)).getResourceCache();
const query = Reflect.get(queries.run, 'query');
if (!query || cache?.read(query) !== queries.run.state)
  throw new Error('The review must use its canonical shared run observation');
const run = queries.run.state.data?.run;
const decision = queries.decision;
const visible = (element) => {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
};
const buttons = [
  ...view.querySelectorAll(
    '[data-testid="review-post"],[data-testid="review-dismiss"],[data-testid="review-refresh"]',
  ),
];
const checkbox = view.querySelector('.rw-ci input');
const rect = checkbox?.getBoundingClientRect();
let hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
for (let depth = 0; depth < 10 && hit?.shadowRoot; depth++) {
  const child = hit.shadowRoot.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!child || child === hit) break;
  hit = child;
}
return {
  mounted: true,
  runId: view.runId,
  readOnly: view.readOnly,
  query: { id: query.id, method: query.method, params: query.params },
  run: {
    status: queries.run.state.status,
    observedAt: queries.run.state.observedAt,
    error: queries.run.state.error?.message,
  },
  canonical: run?.id === view.runId && (view.readOnly ? true : run.decisions.includes(decision)),
  tags: run?.tags,
  decisionId: decision?.id,
  report: view._payload?.reviewMd,
  reportRendered: Boolean(
    view._payload?.reviewMd && view.textContent.includes(view._payload.reviewMd),
  ),
  reportReadable: Boolean(view._payload?.reviewMd && !view.querySelector('.rw-recovery-overlay')),
  reportVisible: visible(view.querySelector('.rw-md-section')),
  pendingConfirm: view._pendingConfirm,
  included: [...view._includedComments],
  initialized: view._initialized,
  curationFingerprint: view._lastCurationFingerprint,
  checkbox: checkbox && {
    checked: checkbox.checked,
    disabled: checkbox.disabled,
    targetAtCenter: hit === checkbox,
    hitTag: hit?.tagName,
    hitClass: hit?.className,
    hitOwnerReadOnly: hit?.closest('review-workspace')?.readOnly,
  },
  paused: view._actionsPaused,
  recovering: view._isRecovering,
  busy: Boolean(view._posting || view._refreshing || view._checkingOut),
  actionError: view._actionError,
  errorRendered: Boolean(view._actionError && view.textContent.includes(view._actionError)),
  errorVisible: visible(view.querySelector('[data-testid="review-action-error"]')),
  saved: view.querySelector('[data-testid="review-run-age"]')?.textContent.trim(),
  savedVisible: visible(view.querySelector('[data-testid="review-run-age"]')),
  buttons: buttons.map((button) => ({
    id: button.dataset.testid,
    disabled: button.disabled,
    text: button.textContent.trim(),
  })),
};
