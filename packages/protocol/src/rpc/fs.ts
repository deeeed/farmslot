import type { FileEntry, OkResult } from '../contracts/index.js';

export interface FsListParams {
  slotId: string;
  path: string;
  depth?: number;
  includeIgnored?: boolean;
}

export interface FsReadParams {
  slotId: string;
  path: string;
}
/**
 * Conditional edits (ADR-009 Amendment 1). `expectedHash` is the SHA-256 of the raw bytes the
 * caller read; `null` means the path must not exist. `runId` names the run the slot must serve,
 * and `null` requires the slot to have no run.
 */
interface FsConditionalParams {
  expectedHash?: string | null;
  runId?: string | null;
}

export interface FsWriteParams extends FsConditionalParams {
  slotId: string;
  path: string;
  content: string;
}

export interface FsWriteResult extends OkResult {
  /**
   * SHA-256 of the bytes written. Returned only when the write carried `expectedHash`; omitted for
   * unconditional writes and by older gateways.
   */
  hash?: string;
}

/** With a precondition, the destination must not exist. */
export interface FsRenameParams extends FsConditionalParams {
  slotId: string;
  oldPath: string;
  newPath: string;
}

export interface FsRenameResult extends OkResult {
  /**
   * SHA-256 of the moved file, the source the precondition checked. Returned only when the rename
   * carried `expectedHash`; omitted for unconditional renames and by older gateways.
   */
  hash?: string;
}

/** A hashed delete applies to files only. */
export interface FsDeleteParams extends FsConditionalParams {
  slotId: string;
  path: string;
}

/** Error codes of the conditional file methods. */
export const FsErrorCodes = {
  /** The precondition failed; the error's details are `FsConflictDetails`. */
  conflict: 'FS_CONFLICT',
  /** A conditional write to a node that does not advertise `conditionalWrites`. */
  preconditionUnsupported: 'FS_PRECONDITION_UNSUPPORTED',
} as const;

export type FsErrorCode = (typeof FsErrorCodes)[keyof typeof FsErrorCodes];

/** Why an `FS_CONFLICT` edit was refused. */
export interface FsConflictDetails {
  /** `hash`: the file differs. `run`: the slot serves another run. `destination-exists`: a guarded rename's target exists. */
  reason: 'hash' | 'run' | 'destination-exists';
  /** The file's current hash; absent when the file does not exist. */
  currentHash?: string;
  /** The run the slot serves; `null` when it serves none. */
  currentRunId?: string | null;
}

export interface FsRevealParams {
  slotId: string;
  path: string;
}

export interface FsMkdirParams {
  slotId: string;
  path: string;
  runId?: string | null;
}
export interface FsListResult {
  entries: FileEntry[];
}

export interface FsReadResult {
  content: string;
  language: string;
  /** SHA-256 of the raw bytes, like the node's `fs.hash`. Omitted by hosts without conditional writes. */
  hash?: string;
}

export interface NodeFsPathParams {
  root: string;
  relPath: string;
}

export interface FileWatchFailure {
  code?: string;
  message: string;
}

export type FileWatchUnavailable = { kind: 'deleted' } | { kind: 'error'; error: FileWatchFailure };

export interface NodeFsWatchParams {
  path: string;
  /** Recursive names/bytes/git-metadata observation, negotiated separately from file content. */
  workspace?: 1;
  /** Opt in to explicit deletion/error observations; absent retains content-only delivery. */
  observations?: 1;
}

/** Experimental arm acknowledgement. Missing initial means no verified observation. */
export interface NodeFsWatchResult {
  watching: true;
  observations?: 1;
  initial?: { kind: 'updated'; content: string } | ({ content: '' } & FileWatchUnavailable);
}

interface NodeFsWatchIdentity {
  requestId: string;
  machine: string;
  path: string;
}

/** Existing nodes omit kind. Content remains a string for the established wire contract. */
export type NodeFsChangedPayload = NodeFsWatchIdentity &
  ({ kind?: 'updated'; content: string } | ({ content: '' } & FileWatchUnavailable));

export interface NodeFsWriteParams extends NodeFsPathParams {
  content: string;
  expectedHash?: string | null;
}

export interface NodeFsRenameParams {
  root: string;
  oldRelPath: string;
  newRelPath: string;
  expectedHash?: string | null;
}

/** Deletes carry the precondition here, so `NodeFsPathParams` stays shared and unchanged. */
export interface NodeFsDeleteParams extends NodeFsPathParams {
  expectedHash?: string | null;
}

export interface NodeFsWriteFileEntry {
  path: string;
  content: string;
  mode?: number;
}

export interface NodeFsWriteFilesParams extends NodeFsPathParams {
  files: NodeFsWriteFileEntry[];
}

export interface NodeFsReadBase64Params extends NodeFsPathParams {
  maxBytes?: number;
}

export interface NodeFsReadChunkParams extends NodeFsPathParams {
  offset: number;
  length: number;
}

export interface NodeFsReadChunkResult {
  content: string;
  size: number;
  offset: number;
  bytesRead: number;
  eof: boolean;
  /** Payload encoding; base64 is the default JSON-safe path. */
  encoding?: 'base64' | 'binary';
}

export interface NodeFsWriteChunkParams extends NodeFsPathParams {
  offset: number;
  content: string;
  /** When true (or offset is 0), create/truncate before writing. */
  truncate?: boolean;
  /** Optional file mode applied on create and after write (e.g. 0o600 attachments). */
  mode?: number;
}

export interface NodeFsWriteChunkResult {
  ok: true;
  bytesWritten: number;
  offset: number;
}

/** Existing fs.watch/fs.watch.stop and node.fs.changed; workspace mode never carries file bytes. */
export interface NodeFsWorkspaceWatchResult {
  workspace: 1;
  ready: true;
}
export interface NodeFsWorkspaceChangedPayload {
  requestId: string;
  path: string;
  machine: string;
  workspace: 1;
  kind: 'updated' | 'error';
  error?: { message: string };
}
