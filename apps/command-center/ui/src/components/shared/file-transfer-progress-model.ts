import type { FileTransferProgress } from '@farmslot/protocol';

export interface FileTransferUiEntry extends FileTransferProgress {
  updatedAt: number;
}

/** Keep completed/failed rows visible so operators and recipe screenshots see the outcome. */
export const FILE_TRANSFER_RETENTION_MS = 30_000;

export function upsertFileTransfer(
  entries: FileTransferUiEntry[],
  progress: FileTransferProgress,
  now = Date.now(),
): FileTransferUiEntry[] {
  const next: FileTransferUiEntry = { ...progress, updatedAt: now };
  const idx = entries.findIndex((e) => e.transferId === progress.transferId);
  if (idx < 0) return [...entries, next];
  const copy = entries.slice();
  copy[idx] = next;
  return copy;
}

export function pruneFileTransfers(
  entries: FileTransferUiEntry[],
  now = Date.now(),
  retentionMs = FILE_TRANSFER_RETENTION_MS,
): FileTransferUiEntry[] {
  return entries.filter((e) => {
    if (e.state === 'running') return true;
    return now - e.updatedAt < retentionMs;
  });
}

export function transferPercent(
  progress: Pick<FileTransferProgress, 'bytesTransferred' | 'totalBytes'>,
): number {
  if (!progress.totalBytes || progress.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((progress.bytesTransferred / progress.totalBytes) * 100));
}

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Strict run scoping for pipeline/run-detail: only transfers that name this run.
 * Unscoped transfers stay on the global banner only (not bound to a run canvas).
 */
export function filterTransfersForRun(
  entries: readonly FileTransferUiEntry[],
  runId: string | undefined | null,
): FileTransferUiEntry[] {
  if (!runId) return [...entries];
  return entries.filter((e) => e.runId === runId);
}

/**
 * Bind a transfer to a pipeline special node so one run-scoped session cannot
 * animate both package-refresh and finalize at once.
 * - package-refresh: mirror phase, not release packaging
 * - finalize: upload phase, or release-artifacts mirror
 */
export function transferForPipelineNode(
  entry: FileTransferUiEntry | null | undefined,
  node: 'package-refresh' | 'finalize',
): FileTransferUiEntry | null {
  if (!entry) return null;
  const label = entry.label ?? '';
  if (node === 'package-refresh') {
    if (entry.phase !== 'mirror') return null;
    if (label.startsWith('release-artifacts')) return null;
    return entry;
  }
  if (entry.phase === 'upload') return entry;
  if (entry.phase === 'mirror' && label.startsWith('release-artifacts')) return entry;
  return null;
}

export function formatPipelineTransferMeta(entry: FileTransferUiEntry): string {
  const pct =
    entry.totalBytes > 0
      ? Math.min(100, Math.round((entry.bytesTransferred / entry.totalBytes) * 100))
      : 0;
  const files =
    entry.filesTotal != null && entry.filesTotal > 0
      ? ` ${entry.filesCompleted ?? 0}/${entry.filesTotal}f`
      : '';
  if (entry.state === 'running') {
    const label = entry.label ? entry.label.slice(0, 14) : entry.phase;
    return `${label} ${pct}%${files}`;
  }
  if (entry.state === 'failed' || entry.state === 'cancelled') {
    return entry.state;
  }
  return entry.state === 'done' ? `done ${pct}%` : entry.state;
}
