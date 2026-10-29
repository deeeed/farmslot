const view = document.querySelector('slot-view');
if (!view) return { mounted: false };
await view.updateComplete;
const root = view.renderRoot;
const editor = root.querySelector('code-viewer');
await editor?.updateComplete;
const readStates = [...(view._workspaceReads?.reads ?? [])].map(([id, read]) => ({
  id,
  method: read.method,
  status: read.state.status,
  observedAt: read.state.observedAt,
  error: read.state.error,
}));
return {
  mounted: true,
  slotId: view.slotId,
  activeFile: view._activeFile,
  ready: view._workspaceReads?.ready,
  status: view._workspaceReads?.status,
  recovery: view._recoveryPhase,
  readStates,
  files: view._entries?.map(({ name, path, type }) => ({ name, path, type })),
  git: view._git,
  content: editor?._editor?.getValue() ?? editor?.content,
  renderedEditor: Boolean(editor?.getClientRects().length),
  treeActionsDisabled: root.querySelector('file-tree')?.actionsDisabled,
  saveDisabled: root.querySelector('.sv-save-btn')?.disabled,
  gitActionsDisabled: root.querySelector('git-changes')?.actionsDisabled,
  visibleStatus: [...root.querySelectorAll('[role="status"]')].map((row) => row.textContent.trim()),
  storage: (await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics())
    ?.storage,
};
