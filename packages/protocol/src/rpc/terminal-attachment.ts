// Terminal image attachments — shared contract for Command Center paste/drag-drop
// delivery into runner terminals. Upload (staging bytes on the slot) and delivery
// (handing the staged path to the runner) are deliberately separate states so a
// finished upload never reads as "the runner received the image".

import type { SlotAgentTargetParams } from './terminal.js';

/** Upper bound for a single staged attachment. */
export const TERMINAL_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Raw bytes carried by one upload frame. Bounded so a large image neither blocks the
 * WebSocket nor collapses progress reporting into a single 0 → 100 jump.
 */
export const TERMINAL_ATTACHMENT_CHUNK_BYTES = 512 * 1024;

export function terminalAttachmentChunkCount(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / TERMINAL_ATTACHMENT_CHUNK_BYTES));
}

/** Image MIME types the gateway is willing to stage. */
export const TERMINAL_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type TerminalAttachmentMime = (typeof TERMINAL_ATTACHMENT_MIME_TYPES)[number];

const TERMINAL_ATTACHMENT_EXTENSIONS: Record<TerminalAttachmentMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function isTerminalAttachmentMime(mime: string): mime is TerminalAttachmentMime {
  return (TERMINAL_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);
}

export function terminalAttachmentExtension(mime: TerminalAttachmentMime): string {
  return TERMINAL_ATTACHMENT_EXTENSIONS[mime];
}

/**
 * Delivery outcome reported by the runner attachment provider.
 * `unsupported` is a first-class result, not an error: runners without a verified
 * provider must say so instead of failing in a way the operator reads as a bug.
 */
export type TerminalAttachmentDeliveryStatus = 'delivered' | 'unsupported' | 'failed';

export interface TerminalAttachmentUploadParams extends SlotAgentTargetParams {
  /** Client-generated idempotency key; repeated uploads of the same id reuse the staged file. */
  attachmentId: string;
  /** Operator-visible source name. Never used to build the stored path. */
  filename: string;
  mimeType: string;
  /** Total size of the whole image, not of this chunk. */
  byteLength: number;
  /** 0-based index of this chunk. Re-sending the same index is idempotent. */
  chunkIndex: number;
  chunkCount: number;
  /** Base64 of this chunk's raw bytes. */
  contentBase64: string;
}

export interface TerminalAttachmentUploadResult {
  attachmentId: string;
  /** False while chunks are still outstanding — nothing has been written to the slot yet. */
  complete: boolean;
  /** Bytes accepted so far; the client renders determinate progress from this. */
  receivedBytes: number;
  byteLength: number;
  mimeType: TerminalAttachmentMime;
  /** Absolute path on the slot machine, always inside Farmslot-managed temp storage. */
  storedPath?: string;
  storedName?: string;
  sha256?: string;
  /** Runner resolved from the slot/run target, or null when no runner is bound. */
  runner?: string | null;
  /** Whether a registered attachment provider exists for that runner. */
  deliverySupported?: boolean;
  /** True when the completed upload overwrote an already-staged attachment id. */
  reused?: boolean;
}

export interface TerminalAttachmentDeliverParams extends SlotAgentTargetParams {
  attachmentId: string;
  storedPath: string;
  filename: string;
}

export interface TerminalAttachmentDeliverResult {
  attachmentId: string;
  status: TerminalAttachmentDeliveryStatus;
  runner: string | null;
  /** Operator-facing explanation — shown verbatim in the attachment card. */
  detail: string;
}

export type TerminalAttachmentCleanupScope = 'all' | 'stale';

export interface TerminalAttachmentCleanupParams {
  slotId: string;
  /** `all` clears the slot's staging dir (lifecycle end); `stale` only bounded-age leftovers. */
  scope?: TerminalAttachmentCleanupScope;
}

export interface TerminalAttachmentCleanupResult {
  slotId: string;
  scope: TerminalAttachmentCleanupScope;
  removed: string[];
}
