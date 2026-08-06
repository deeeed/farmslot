// terminal-attachment-model.ts — pure validation + path derivation for terminal image
// attachments. Kept free of IO so the containment and limit rules are directly testable.

import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  isTerminalAttachmentMime,
  TERMINAL_ATTACHMENT_CHUNK_BYTES,
  TERMINAL_ATTACHMENT_MAX_BYTES,
  terminalAttachmentChunkCount,
  terminalAttachmentExtension,
  type TerminalAttachmentMime,
  type TerminalAttachmentUploadParams,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { resolvePathWithinRemoteBase } from '../core/remote-paths.js';

/** Directory name under the project runtime dir that holds staged attachments. */
export const TERMINAL_ATTACHMENT_DIR_NAME = '.attachments';

/** Interrupted uploads older than this are removed by the bounded stale sweep. */
export const TERMINAL_ATTACHMENT_STALE_MS = 6 * 60 * 60 * 1000;

export function terminalAttachmentDir(repoPath: string, runtimeDir = '.agent'): string {
  return path.posix.join(repoPath, runtimeDir, TERMINAL_ATTACHMENT_DIR_NAME);
}

/**
 * Stored names are derived from the attachment id only — never from the browser-supplied
 * filename — so no client string reaches the filesystem path. The derivation is stable so a
 * repeated upload of the same attachment id lands on the same staged file instead of
 * multiplying copies.
 */
export function terminalAttachmentStoredName(
  attachmentId: string,
  mime: TerminalAttachmentMime,
): string {
  const digest = createHash('sha256').update(attachmentId).digest('hex').slice(0, 24);
  return `att-${digest}.${terminalAttachmentExtension(mime)}`;
}

export function isTerminalAttachmentStoredName(name: string): boolean {
  return /^att-[0-9a-f]{24}\.(png|jpg|gif|webp)$/.test(name);
}

/**
 * Resolve a staged file path inside the slot's attachment directory. Returns null when the
 * candidate would escape that directory, so callers fail closed instead of writing anywhere
 * the browser asks for.
 */
export function resolveTerminalAttachmentPath(dir: string, storedName: string): string | null {
  if (!isTerminalAttachmentStoredName(storedName)) return null;
  return resolvePathWithinRemoteBase(dir, storedName);
}

export interface ValidatedTerminalAttachmentChunk {
  attachmentId: string;
  mimeType: TerminalAttachmentMime;
  byteLength: number;
  chunkIndex: number;
  chunkCount: number;
  chunk: Buffer;
}

/**
 * Every chunk frame carries the full envelope (mime, total size, chunk shape) and is
 * validated on its own, so a client cannot pass a benign first frame and then smuggle an
 * oversized or non-image payload through a later one.
 */
export function validateTerminalAttachmentChunk(
  params: TerminalAttachmentUploadParams,
): ValidatedTerminalAttachmentChunk {
  const attachmentId = params.attachmentId?.trim() ?? '';
  if (!attachmentId) {
    throw new GatewayMethodError(
      'ATTACHMENT_INVALID_ID',
      'terminal.attachment.upload requires a non-empty attachmentId',
    );
  }
  if (!isTerminalAttachmentMime(params.mimeType)) {
    throw new GatewayMethodError(
      'ATTACHMENT_UNSUPPORTED_MIME',
      `Unsupported attachment type ${params.mimeType || '(none)'} — images only`,
      { userAction: 'Paste or drop a PNG, JPEG, GIF, or WebP image.' },
    );
  }
  if (!Number.isInteger(params.byteLength) || params.byteLength <= 0) {
    throw new GatewayMethodError(
      'ATTACHMENT_INVALID_SIZE',
      `Attachment byteLength must be a positive integer (got ${params.byteLength})`,
    );
  }
  if (params.byteLength > TERMINAL_ATTACHMENT_MAX_BYTES) {
    throw new GatewayMethodError(
      'ATTACHMENT_TOO_LARGE',
      `Attachment is ${params.byteLength} bytes; limit is ${TERMINAL_ATTACHMENT_MAX_BYTES}`,
      { userAction: 'Resize or compress the image before attaching it.' },
    );
  }
  const chunkCount = terminalAttachmentChunkCount(params.byteLength);
  if (params.chunkCount !== chunkCount) {
    throw new GatewayMethodError(
      'ATTACHMENT_INVALID_CHUNK',
      `Attachment of ${params.byteLength} bytes needs ${chunkCount} chunk(s), got chunkCount=${params.chunkCount}`,
    );
  }
  if (
    !Number.isInteger(params.chunkIndex) ||
    params.chunkIndex < 0 ||
    params.chunkIndex >= chunkCount
  ) {
    throw new GatewayMethodError(
      'ATTACHMENT_INVALID_CHUNK',
      `chunkIndex ${params.chunkIndex} is outside 0..${chunkCount - 1}`,
    );
  }
  const chunk = Buffer.from(params.contentBase64 ?? '', 'base64');
  const expected = expectedChunkBytes(params.byteLength, params.chunkIndex);
  if (chunk.byteLength !== expected) {
    throw new GatewayMethodError(
      'ATTACHMENT_SIZE_MISMATCH',
      `Chunk ${params.chunkIndex} decoded to ${chunk.byteLength} bytes but should be ${expected}`,
    );
  }
  return {
    attachmentId,
    mimeType: params.mimeType,
    byteLength: params.byteLength,
    chunkIndex: params.chunkIndex,
    chunkCount,
    chunk,
  };
}

/**
 * Bounded stale policy for interrupted uploads. Fails closed on an unusable timestamp — a node
 * build older than the `mtimeMs` addition reports none, and an unknown age must never read as
 * "infinitely stale" and delete an upload that is still in flight.
 */
export function isStaleTerminalAttachment(mtimeMs: number | undefined, now: number): boolean {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return false;
  return now - mtimeMs >= TERMINAL_ATTACHMENT_STALE_MS;
}

export function expectedChunkBytes(byteLength: number, chunkIndex: number): number {
  const start = chunkIndex * TERMINAL_ATTACHMENT_CHUNK_BYTES;
  return Math.min(TERMINAL_ATTACHMENT_CHUNK_BYTES, byteLength - start);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
