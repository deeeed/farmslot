import type { ExecResult } from '../contracts/common.js';
import type {
  NodeFsDeleteParams,
  NodeFsPathParams,
  NodeFsReadChunkParams,
  NodeFsReadChunkResult,
  NodeFsRenameParams,
  NodeFsWriteChunkParams,
  NodeFsWriteChunkResult,
  NodeFsWriteFilesParams,
  NodeFsWriteParams,
} from '../rpc/fs.js';

import {
  isNodeLinkAuthority,
  isNodeLinkTarget,
  type NodeLinkAuthority,
  type NodeLinkCommand,
  type NodeLinkTarget,
} from './node-link.js';

export interface NodeLinkFileInfo {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
}

export interface NodeLinkTerminalSize {
  cols: number;
  rows: number;
}

export interface NodeLinkProcessUpdate {
  kind: 'started' | 'output';
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface NodeLinkProcessInput {
  /** Exactly approved argv; shell command strings are not part of this contract. */
  argv: string[];
  cwd: string;
  timeoutMs: number;
  closeoutTimeoutMs?: number;
  maxOutputBytes: number;
  environment?: 'service' | 'login';
  /** Node-owned PTY attachment. Input uses the existing sequenced terminal command. */
  terminal?: NodeLinkTerminalSize;
}

export interface NodeLinkWriteFilesInput extends NodeFsWriteFilesParams {
  createOnly?: boolean;
}

export interface NodeLinkFileCommitInput {
  root: string;
  stagedRelPath: string;
  destinationRelPath: string;
  sha256: string;
  size: number;
  createOnly?: boolean;
}

export interface NodeLinkOutputDigest {
  bytes: number;
  sha256: string;
}
export interface NodeLinkProcessSummary {
  kind: 'streamed-process-result';
  exitCode: number;
  stdout: NodeLinkOutputDigest;
  stderr: NodeLinkOutputDigest;
}

export interface NodeLinkOperationMap {
  'system.which': {
    input: { programs: string[] };
    result: { paths: Record<string, string | null> };
  };
  'file.exists': { input: NodeFsPathParams; result: { exists: boolean } };
  'file.commit': { input: NodeLinkFileCommitInput; result: { committed: boolean; sha256: string } };
  'file.inspect': { input: NodeFsPathParams; result: NodeLinkFileInfo };
  'file.read': { input: NodeFsPathParams; result: { content: string; hash: string } };
  'file.read-range': { input: NodeFsReadChunkParams; result: NodeFsReadChunkResult };
  'file.hash': { input: NodeFsPathParams; result: { sha256: string; size: number } };
  'file.write': { input: NodeFsWriteParams; result: { ok: true; hash?: string } };
  'file.write-range': { input: NodeFsWriteChunkParams; result: NodeFsWriteChunkResult };
  'file.write-files': { input: NodeLinkWriteFilesInput; result: { ok: true; count: number } };
  'file.mkdir': { input: NodeFsPathParams; result: { ok: true } };
  'file.delete': { input: NodeFsDeleteParams; result: { ok: true } };
  'file.rename': { input: NodeFsRenameParams; result: { ok: true; hash?: string } };
  'process.run': { input: NodeLinkProcessInput; result: ExecResult | NodeLinkProcessSummary };
}

export type NodeLinkOperation = keyof NodeLinkOperationMap;
export type TypedNodeLinkCommand = {
  [Operation in NodeLinkOperation]: NodeLinkCommand<NodeLinkOperationMap[Operation]['input']> & {
    operation: Operation;
  };
}[NodeLinkOperation];

/** Server-to-node grant. It is never a public launch/delegation parameter. */
export interface NodeLinkGrant {
  target: NodeLinkTarget;
  authority: NodeLinkAuthority;
  expiresAt: number;
  operations: NodeLinkOperation[];
  /** Canonical admitted workspace; file inputs cannot replace it. */
  root?: string;
  /** A process request must match this exact admitted argv/cwd/limit policy. */
  process?: NodeLinkProcessInput;
}

export const NODE_LINK_OPERATIONS: NodeLinkOperation[] = [
  'system.which',
  'file.exists',
  'file.commit',
  'file.inspect',
  'file.read',
  'file.read-range',
  'file.hash',
  'file.write',
  'file.write-range',
  'file.write-files',
  'file.mkdir',
  'file.delete',
  'file.rename',
  'process.run',
];

/** Unknown future operation names remain unsupported without breaking peer registration. */
export function nodeLinkCapabilities(
  value: unknown,
): import('./node-link.js').NodeLinkCapabilities | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const commands = 'commands' in value && value.commands === 1;
  const streams = 'streams' in value && value.streams === 1;
  const offered = 'operations' in value && Array.isArray(value.operations) ? value.operations : [];
  const operations = NODE_LINK_OPERATIONS.filter((operation) => offered.includes(operation));
  return { ...(commands ? { commands: 1 } : {}), ...(streams ? { streams: 1 } : {}), operations };
}

export type NodeLinkOperationRequest = {
  [Operation in NodeLinkOperation]: {
    operation: Operation;
    input: NodeLinkOperationMap[Operation]['input'];
  };
}[NodeLinkOperation];

export function isNodeLinkGrant(value: unknown): value is NodeLinkGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return (
    isNodeLinkTarget(grant.target) &&
    isNodeLinkAuthority(grant.authority) &&
    typeof grant.expiresAt === 'number' &&
    Number.isFinite(grant.expiresAt) &&
    Array.isArray(grant.operations) &&
    grant.operations.every((operation) =>
      NODE_LINK_OPERATIONS.some((known) => known === operation),
    ) &&
    (grant.root === undefined || typeof grant.root === 'string') &&
    (grant.process === undefined || isNodeLinkProcessInput(grant.process))
  );
}

export function isNodeLinkProcessInput(value: unknown): value is NodeLinkProcessInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const process = value as Record<string, unknown>;
  return (
    Array.isArray(process.argv) &&
    process.argv.every((arg) => typeof arg === 'string') &&
    typeof process.cwd === 'string' &&
    typeof process.timeoutMs === 'number' &&
    Number.isFinite(process.timeoutMs) &&
    typeof process.maxOutputBytes === 'number' &&
    Number.isFinite(process.maxOutputBytes)
  );
}
