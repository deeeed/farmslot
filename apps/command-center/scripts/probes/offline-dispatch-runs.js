const view = document.querySelector('dispatch-wizard');
if (!view?.shadowRoot) return { mounted: false };
const picker = Reflect.get(view, 'comparisonQuery');
const baseline = Reflect.get(view, 'baselineQuery');
const cacheUrl = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname === '/src/resource-cache.ts')
  .at(-1);
if (!cacheUrl) throw new Error('The current resource cache module did not load');
const cache = (await import(cacheUrl)).getResourceCache();
const read = (controller) => {
  const query = Reflect.get(controller, 'query');
  if (query && cache?.read(query) !== controller.state)
    throw new Error('Inspect the canonical observation rendering the dispatch runs');
  return {
    query: query && { id: query.id, method: query.method, params: query.params },
    status: controller.state.status,
    observedAt: controller.state.observedAt,
    error: controller.state.error?.message,
  };
};
const root = view.shadowRoot;
const runs = Reflect.get(view, '_comparisonRows');
const tray = document.querySelector('farm-notification-tray')?.shadowRoot;
const noticesClosed = tray?.querySelector('.bell')?.getAttribute('aria-expanded') === 'false';
const readNotice = (id) =>
  [...(tray?.querySelectorAll('[data-notice-id]') ?? [])].find(
    (item) => item.getAttribute('data-notice-id') === `read:${id}`,
  );
const noticeText = (item) => item?.querySelector('p')?.textContent.trim();
return {
  mounted: true,
  noticesClosed,
  readNoticesNeeded: [picker, baseline].some(
    (controller) => controller.state.status === 'stale' || Boolean(controller.state.error),
  ),
  open: Reflect.get(view, '_comparePickerOpen'),
  pickerReady: Reflect.get(view, '_comparisonReady'),
  contextBlocked:
    Reflect.get(view, '_hydrating') ||
    Reflect.get(view, '_bootstrapFailed') ||
    Reflect.get(view, '_connectionStale'),
  runInputsReady: Reflect.get(view, '_runInputsReady').call(view),
  selectedBaseline: Reflect.get(view, '_comparisonParentRunId'),
  ticket: Reflect.get(view, '_ticketId'),
  picker: read(picker),
  baseline: read(baseline),
  canonicalRows: runs.every((run) => picker.state.data?.runs.includes(run)),
  pickerAge: noticeText(readNotice(Reflect.get(picker, 'query')?.id)),
  baselineAge: noticeText(readNotice(Reflect.get(baseline, 'query')?.id)),
  readError: picker.state.error
    ? noticeText(readNotice(Reflect.get(picker, 'query')?.id))
    : undefined,
  baselineError: baseline.state.error
    ? noticeText(readNotice(Reflect.get(baseline, 'query')?.id))
    : undefined,
  activeCard: root.activeElement?.getAttribute('data-run-id'),
  cards: [...root.querySelectorAll('[data-testid="dispatch-compare-run-card"]')].map((card) => ({
    id: card.getAttribute('data-run-id'),
    text: card.textContent.trim(),
    disabled: card.getAttribute('aria-disabled') === 'true',
    visible: Boolean(card.getClientRects().length),
  })),
  actionError: Reflect.get(view, '_error'),
};
