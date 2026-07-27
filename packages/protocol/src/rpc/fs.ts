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
export interface FsWriteParams {
  slotId: string;
  path: string;
  content: string;
}

export type FsWriteResult = OkResult;

export interface FsRenameParams {
  slotId: string;
  oldPath: string;
  newPath: string;
}

export interface FsDeleteParams {
  slotId: string;
  path: string;
}

export interface FsRevealParams {
  slotId: string;
  path: string;
}

export interface FsMkdirParams {
  slotId: string;
  path: string;
}
export interface FsListResult {
  entries: FileEntry[];
}

export interface FsReadResult {
  content: string;
  language: string;
}

export interface NodeFsPathParams {
  root: string;
  relPath: string;
}

export interface NodeFsWriteParams extends NodeFsPathParams {
  content: string;
}

export interface NodeFsRenameParams {
  root: string;
  oldRelPath: string;
  newRelPath: string;
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
