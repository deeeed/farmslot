// Read-only positions and view states. No UI state or content is changed.
const view = document.querySelector('slot-view');
// Measurement identities are separate from application state and never affect rendering.
const identityKey = Symbol.for('farmslot.slot-layout.measurement');
const identities = (globalThis[identityKey] ??= { nodes: new WeakMap(), next: 1 });
const selectors = [
  'slot-view',
  '.sv-header',
  '.sv-body',
  '.sv-sidebar',
  '.sv-right-col',
  '.sv-editor-row',
  '.sv-stream-col',
  '.sv-task-panel-col',
  '.sv-run-panel',
  '.sv-terminal-panel',
  '.sv-bottom-tabs',
  'terminal-view',
  '.sv-review-col',
];
const regions = Object.fromEntries(
  selectors.map((selector) => {
    const node = selector === 'slot-view' ? view : view?.querySelector(selector);
    const rect = node?.getBoundingClientRect();
    if (node && !identities.nodes.has(node)) identities.nodes.set(node, identities.next++);
    return [
      selector,
      rect && {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        identity: identities.nodes.get(node),
      },
    ];
  }),
);
return {
  at: performance.now(),
  connected: document.querySelector('farm-app')?.connection === 'connected',
  slotId: view?.slotId,
  runId: view?._linkedRun?.id,
  recovery: view?._recoveryPhase,
  workspaceStatus: view?._workspaceReads?.status,
  taskOpen: view?._taskPanelOpen,
  resourceOpen: view?._resourcePanelOpen,
  recipeOpen: view?._reviewPanelOpen,
  terminalHeight: view?._terminalHeight,
  rightColHeight: view?._rightColHeight,
  topRows: [...(view?.children ?? [])]
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return { tag: node.tagName, className: node.className, height: rect.height, y: rect.y };
    })
    .filter((row) => row.height > 0),
  activePrepare: view?._activePrepare
    ? { running: view._activePrepare.running, exitCode: view._activePrepare.exitCode }
    : null,
  regions,
};
