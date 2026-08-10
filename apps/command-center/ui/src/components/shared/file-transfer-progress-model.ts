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

export function transferPercent(progress: Pick<FileTransferProgress, 'bytesTransferred' | 'totalBytes'>): number {
  if (!progress.totalBytes || progress.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((progress.bytesTransferred / progress.totalBytes) * 100));
}

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
