import type { NativeSessionTargetParams, NativeWorkerControlTarget } from '@farmslot/protocol';

import { resolveFileChipTarget } from '../t3/features/threads/fileChipMenu';

/** The session a message belongs to, and the folder its relative file links resolve against. */
export interface NativeWorkspaceTarget extends NativeSessionTargetParams {
  executionNodeId: string;
  cwd: string;
}

/** Route params for `/native-file`, all strings. */
export interface NativeFileRouteParams {
  sessionId: string;
  executionNodeId: string;
  path: string;
  line?: string;
  runId?: string;
  contextId?: string;
  generation?: string;
  leaseId?: string;
}

export interface NativeFileLocation {
  /** Relative to the session's folder, as the workspace RPCs take it. */
  path: string;
  line?: number;
}

/** A markdown link to a file inside the session's folder, or null for any other link. */
export function nativeFileLocation(href: string, cwd: string): NativeFileLocation | null {
  const target = resolveFileChipTarget(href, cwd);
  if (!target?.relativePath) return null;
  return { path: target.relativePath, ...(target.line ? { line: target.line } : {}) };
}

export function nativeFileRouteParams(
  target: NativeWorkspaceTarget,
  location: NativeFileLocation,
): NativeFileRouteParams {
  return {
    sessionId: target.sessionId,
    executionNodeId: target.executionNodeId,
    path: location.path,
    ...(location.line ? { line: String(location.line) } : {}),
    ...(target.worker ? { ...target.worker } : {}),
  };
}

/** The workspace RPC target and file a `/native-file` route names, or null when incomplete. */
export function nativeFileRouteTarget(
  params: Partial<Record<keyof NativeFileRouteParams, string>>,
): {
  target: NativeSessionTargetParams & { executionNodeId: string };
  location: NativeFileLocation;
} | null {
  const { sessionId, executionNodeId, path } = params;
  if (!sessionId || !executionNodeId || !path) return null;
  const line = params.line ? Number(params.line) : undefined;
  const worker: NativeWorkerControlTarget | undefined =
    params.runId && params.contextId && params.leaseId
      ? {
          runId: params.runId,
          contextId: params.contextId,
          generation: params.generation ?? '',
          leaseId: params.leaseId,
        }
      : undefined;
  return {
    target: { sessionId, executionNodeId, ...(worker ? { worker } : {}) },
    location: {
      path,
      ...(line !== undefined && Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    },
  };
}
