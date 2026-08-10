// Chunked remote file transfer contract (node ↔ gateway ↔ Command Center).
// Progress events keep large copies observable and idle-timeout-based, instead of
// dying on a blind 30s wall clock with no operator-visible state.

/**
 * Max raw bytes per chunk before encoding. Base64 expands ~4/3; binary frames carry
 * raw bytes (node→gateway JSON still wraps base64 today when encoding=base64).
 * Stays far under `DEFAULT_WS_MAX_PAYLOAD_BYTES` (100 MiB) with JSON envelope.
 */
export const FILE_TRANSFER_CHUNK_MAX_BYTES = 512 * 1024;

/** Files at or below this size may use one-shot `fs.readBase64` (no progress UI). */
export const FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES = 256 * 1024;

/**
 * Baseline idle timeout. Use `fileTransferIdleTimeoutMs(totalBytes)` so larger
 * files get a scaled stall window without a blind whole-transfer wall clock.
 */
export const FILE_TRANSFER_IDLE_TIMEOUT_MS = 60_000;

/** Extra idle budget per MiB of total size (capped). */
export const FILE_TRANSFER_IDLE_TIMEOUT_PER_MIB_MS = 2_000;

/** Upper bound for size-scaled idle timeout. */
export const FILE_TRANSFER_IDLE_TIMEOUT_MAX_MS = 5 * 60_000;

/** Per-chunk node RPC timeout — resets every chunk, not one wall clock for the whole file. */
export const FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS = 60_000;

/**
 * Coalesce running progress broadcasts to ~2 Hz so multi-GB trees do not spam
 * open Command Center clients. Terminal states (done/failed/cancelled) always flush.
 */
export const FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS = 500;

export const FILE_TRANSFER_PHASES = ['upload', 'download', 'mirror'] as const;
export type FileTransferPhase = (typeof FILE_TRANSFER_PHASES)[number];

export const FILE_TRANSFER_STATES = ['running', 'done', 'failed', 'cancelled'] as const;
export type FileTransferState = (typeof FILE_TRANSFER_STATES)[number];

/**
 * Chunk payload encoding. `base64` is the default JSON-safe path.
 * `binary` is reserved for raw byte frames when the transport supports them;
 * gateway/node still accept base64-decoded equivalence for integrity checks.
 */
export const FILE_TRANSFER_ENCODINGS = ['base64', 'binary'] as const;
export type FileTransferEncoding = (typeof FILE_TRANSFER_ENCODINGS)[number];

/** Size-scaled idle timeout: base + per-MiB, capped. */
export function fileTransferIdleTimeoutMs(totalBytes: number): number {
  const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const mib = bytes / (1024 * 1024);
  const scaled =
    FILE_TRANSFER_IDLE_TIMEOUT_MS + Math.ceil(mib) * FILE_TRANSFER_IDLE_TIMEOUT_PER_MIB_MS;
  return Math.min(FILE_TRANSFER_IDLE_TIMEOUT_MAX_MS, Math.max(FILE_TRANSFER_IDLE_TIMEOUT_MS, scaled));
}

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
  /** Multi-file mirror/dir aggregate. */
  filesCompleted?: number;
  filesTotal?: number;
  /** Parent aggregate session id when this is a per-file child. */
  parentTransferId?: string;
  encoding?: FileTransferEncoding;
  /** True while running and cancel is supported. */
  cancellable?: boolean;
  /** Resume offset if a partial local file is being continued. */
  resumeOffset?: number;
  bytesPerSec?: number;
}

export interface FileTransferCancelParams {
  transferId: string;
}

export interface FileTransferCancelResult {
  ok: true;
  transferId: string;
  state: 'cancelled' | 'already-terminal';
}

export interface FileTransferListParams {
  runId?: string;
  slotId?: string;
}

export interface FileTransferListResult {
  transfers: FileTransferProgress[];
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
  phase?: FileTransferPhase;
  /** When true, leave a partial file and resume mid-transfer (smoke of resume path). */
  exerciseResume?: boolean;
}

export interface FileTransferSmokeResult {
  transferId: string;
  size: number;
  sha256: string;
  progressEvents: number;
  intermediateEvents: number;
  cancelled?: boolean;
}

/**
 * Admin/diagnostics smoke path. Prefer this name in new code.
 * `file.transfer.smoke` remains a routed alias for older recipes.
 */
export const FileTransferMethods = {
  smoke: 'diagnostics.fileTransfer.smoke',
  smokeAlias: 'file.transfer.smoke',
  cancel: 'file.transfer.cancel',
  list: 'file.transfer.list',
} as const;
