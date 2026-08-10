// Chunked remote file transfer contract (node ↔ gateway ↔ Command Center).
// Progress events keep large copies observable and idle-timeout-based, instead of
// dying on a blind 30s wall clock with no operator-visible state.

/**
 * Max raw bytes per chunk before base64. Base64 expands ~4/3, so each WS frame
 * stays far under `DEFAULT_WS_MAX_PAYLOAD_BYTES` (100 MiB) with JSON envelope.
 */
export const FILE_TRANSFER_CHUNK_MAX_BYTES = 512 * 1024;

/** Files at or below this size may use one-shot `fs.readBase64` (no progress UI). */
export const FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES = 256 * 1024;

/**
 * Fail a transfer if no progress advances for this long. Healthy multi-minute
 * copies that keep emitting chunks succeed; a stalled peer still fails closed.
 */
export const FILE_TRANSFER_IDLE_TIMEOUT_MS = 60_000;

/** Per-chunk node RPC timeout — resets every chunk, not one wall clock for the whole file. */
export const FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS = 60_000;

export const FILE_TRANSFER_PHASES = ['upload', 'download', 'mirror'] as const;
export type FileTransferPhase = (typeof FILE_TRANSFER_PHASES)[number];

export const FILE_TRANSFER_STATES = ['running', 'done', 'failed'] as const;
export type FileTransferState = (typeof FILE_TRANSFER_STATES)[number];

/** Determinate transfer progress broadcast to open Command Center clients. */
export interface FileTransferProgress {
  transferId: string;
  /** Absolute or operator-visible path being transferred. */
  path: string;
  /** Optional short label (basename, artifact key). */
  label?: string;
  phase: FileTransferPhase;
  bytesTransferred: number;
  totalBytes: number;
  state: FileTransferState;
  error?: string;
  runId?: string;
  slotId?: string;
  sha256?: string;
}

export interface FileTransferSmokeParams {
  /** Total fixture size in bytes (default: 3 chunks). Must be > small-file threshold for multi-chunk. */
  totalBytes?: number;
  /** Artificial delay between chunks to exercise intermediate progress (default 0). */
  chunkDelayMs?: number;
  /** Optional label shown in the progress UI. */
  label?: string;
  runId?: string;
  slotId?: string;
}

export interface FileTransferSmokeResult {
  transferId: string;
  size: number;
  sha256: string;
  progressEvents: number;
  intermediateEvents: number;
}

export const FileTransferMethods = {
  smoke: 'file.transfer.smoke',
} as const;
