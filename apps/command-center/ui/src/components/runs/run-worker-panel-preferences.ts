import { viewToggleField } from '@farmslot/protocol';

import { browserViewState } from '../../utils/view-state.js';

export type RunWorkerPanelKind = 'conversation' | 'terminal';
function panelField(runId: string, kind: RunWorkerPanelKind) {
  return viewToggleField('workers', `${runId}:${kind}`, false);
}

export function runWorkerPanelOpen(
  owner: string | undefined,
  runId: string,
  kind: RunWorkerPanelKind,
): boolean {
  return Boolean(owner && runId) && browserViewState.get(panelField(runId, kind));
}

export function rememberRunWorkerPanel(
  owner: string | undefined,
  runId: string,
  kind: RunWorkerPanelKind,
  open: boolean,
): void {
  if (owner && runId) browserViewState.set(panelField(runId, kind), open);
}

export function toggleRunWorkerPanel(
  owner: string | undefined,
  runId: string,
  kind: RunWorkerPanelKind,
): boolean {
  const open = !runWorkerPanelOpen(owner, runId, kind);
  rememberRunWorkerPanel(owner, runId, kind, open);
  return open;
}
