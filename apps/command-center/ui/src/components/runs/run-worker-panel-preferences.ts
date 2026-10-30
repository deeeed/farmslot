import { safeLsGet, safeLsSet } from '../../utils/storage.js';

export type RunWorkerPanelKind = 'conversation' | 'terminal';

function preferenceKey(owner: string | undefined, runId: string, kind: RunWorkerPanelKind) {
  return owner && runId ? `cc:run-worker-panel:${JSON.stringify([owner, runId, kind])}` : undefined;
}

export function runWorkerPanelOpen(
  owner: string | undefined,
  runId: string,
  kind: RunWorkerPanelKind,
): boolean {
  const key = preferenceKey(owner, runId, kind);
  return key !== undefined && safeLsGet(key) === '1';
}

export function rememberRunWorkerPanel(
  owner: string | undefined,
  runId: string,
  kind: RunWorkerPanelKind,
  open: boolean,
): void {
  const key = preferenceKey(owner, runId, kind);
  if (key) safeLsSet(key, open ? '1' : '0');
}
