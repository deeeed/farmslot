const list = document.querySelector('run-list');
if (!list?.shadowRoot) return { mounted: false };
const url = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname === '/src/state.ts')
  .at(-1);
const state = url
  ? (await import(url)).getState()
  : {
      runsObservation: Reflect.get(list, 'runsObservation'),
      connection: document.querySelector('farm-app')?.connection,
    };
if (state.runsObservation !== Reflect.get(list, 'runsObservation'))
  throw new Error('The probe must read the module owning the rendered run list');
const tag = Reflect.get(list, 'tagQuery')?.state;
const root = list.shadowRoot;
const commands = [...root.querySelectorAll('.new-run-btn, .action-btn.cleanup, .inline-action')];
const tagEditors = [...root.querySelectorAll('run-tag-editor')].filter(
  (editor) => typeof editor.saveTags === 'function',
);
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
  readNoticesNeeded: state.runsObservation.status === 'stale',
  storage: (await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics())
    ?.storage,
  freshness: state.runsObservation.status,
  observedAt: state.runsObservation.observedAt,
  tag: Reflect.get(list, 'tagFilter'),
  tagFreshness: tag?.status,
  tagObservedAt: tag?.observedAt,
  connection: state.connection,
  selectedCount: Reflect.get(list, 'selectedIds')?.size,
  actionInProgress: Reflect.get(list, 'actionInProgress'),
  archiveDisabled: root.querySelector('.actions-bar.manage .action-btn.cleanup')?.disabled,
  rows: [...root.querySelectorAll('[data-row-id]')].map((row) => ({
    id: row.getAttribute('data-row-id'),
    visible: Boolean(row.getClientRects().length),
  })),
  stale: noticeText(
    [...(tray?.querySelectorAll('[data-notice-id]') ?? [])].find(
      (item) =>
        item.getAttribute('data-notice-id')?.startsWith('read:run.list:') &&
        item.querySelector('strong')?.textContent.startsWith('Saved'),
    ),
  ),
  actionsDisabled:
    commands.length > 0 &&
    tagEditors.length > 0 &&
    commands.every((button) => button.disabled) &&
    tagEditors.every((editor) => editor.disabled),
};
