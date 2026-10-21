const list = document.querySelector('run-list');
if (!list?.shadowRoot) return { mounted: false };
const url = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname === '/src/state.ts')
  .at(-1);
if (!url) throw new Error('The application state module did not load');
const state = (await import(url)).getState();
if (state.runsObservation !== Reflect.get(list, 'runsObservation'))
  throw new Error('The probe must read the module owning the rendered run list');
const tag = Reflect.get(list, 'tagQuery')?.state;
const root = list.shadowRoot;
const commands = [...root.querySelectorAll('.new-run-btn, .action-btn.cleanup, .inline-action')];
const tagEditors = [...root.querySelectorAll('run-tag-editor')];
return {
  mounted: true,
  storage: (await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics())
    ?.storage,
  freshness: state.runsObservation.status,
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
  stale: root.querySelector('[data-run-freshness="stale"]')?.textContent?.trim(),
  actionsDisabled:
    commands.length > 0 &&
    tagEditors.length > 0 &&
    commands.every((button) => button.disabled) &&
    tagEditors.every((editor) => editor.disabled),
};
