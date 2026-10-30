import { safeLsGet, safeLsRemove, safeLsSet } from '../../utils/storage.js';

export type RunWorkerPanelKind = 'conversation' | 'terminal';
const choices = new Map<string, boolean>();

function preferenceKey(owner: string | undefined, runId: string, kind: RunWorkerPanelKind) {
  return owner && runId ? `cc:run-worker-panel:${JSON.stringify([owner, runId, kind])}` : undefined;
}

export function runWorkerPanelOpen(
  owner: string | undefined,
  runId: string,
  kind: RunWorkerPanelKind,
): boolean {
  const key = preferenceKey(owner, runId, kind);
  return key !== undefined && (choices.get(key) ?? safeLsGet(key) === '1');
}

export function rememberRunWorkerPanel(
  owner: string | undefined,
  runId: string,
  kind: RunWorkerPanelKind,
  open: boolean,
): void {
  const key = preferenceKey(owner, runId, kind);
  if (!key) return;
  // Disclosure still works when browser storage is blocked; only reload persistence is lost.
  choices.set(key, open);
  if (open) safeLsSet(key, '1');
  else safeLsRemove(key);
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
