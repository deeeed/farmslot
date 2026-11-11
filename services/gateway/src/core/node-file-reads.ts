// Remote slot file reads answered by the node daemon without a shell (`fs.readText`, `fs.isFile`).
import path from 'node:path';

import type {
  NodeFsIsFileResult,
  NodeFsReadTextParams,
  NodeFsReadTextResult,
} from '@farmslot/protocol';
import { currentProjectSources } from '@farmslot/slot-config';

import { getNode } from '../fleet/machine-registry.js';
import { usesNodeLink } from '../fleet/node-link-policy.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';

import type { SlotVars } from './config.js';
import { isLocal } from './exec.js';
import { currentSlotCommandExecutor } from './exec-scope.js';
import { isShellHomePath, nodePathParams, normalizeRemotePath } from './remote-paths.js';

/**
 * Whether a remote slot's files are read through its node's `fs.readText`/`fs.isFile` instead of
 * a shell: `execOnSlot` would hand the command to this node's plain exec (no workspace owner,
 * project sources or node link), and the connected node declares the reads. An older node, or
 * none, keeps the shell read.
 */
export function slotFilesReadThroughNode(vars: Pick<SlotVars, 'host' | 'machine'>): boolean {
  return (
    !currentSlotCommandExecutor() &&
    !currentProjectSources() &&
    !isLocal(vars.host, vars.machine) &&
    !usesNodeLink(vars.machine) &&
    getNode(vars.machine)?.observationCapabilities?.textReads === 1
  );
}

type NodeReadMethod = 'fs.readText' | 'fs.isFile';
const nodeReads = new Map<string, Promise<unknown>>();

/** Concurrent pollers of one file share a single node request until it settles. */
function shareNodeRead(
  vars: Pick<SlotVars, 'machine' | 'remoteRepo'>,
  method: NodeReadMethod,
  file: string,
  timeout: number,
  extra: Pick<NodeFsReadTextParams, 'tailBytes'> = {},
): Promise<unknown> {
  // A slot path as its shell would resolve it: `~` is the node user's home, relative is the repo.
  const normalized = normalizeRemotePath(file);
  const full =
    isShellHomePath(normalized) || path.posix.isAbsolute(normalized)
      ? normalized
      : path.posix.join(vars.remoteRepo, normalized);
  const params = { ...nodePathParams(full), ...extra };
  const key = JSON.stringify([vars.machine, method, params]);
  const existing = nodeReads.get(key);
  if (existing) return existing;
  const node = getNode(vars.machine);
  if (!node) return Promise.reject(new Error(`Node ${vars.machine} is not connected`));
  const flight = sendNodeRequest(node, method, params, { timeout }).finally(() => {
    if (nodeReads.get(key) === flight) nodeReads.delete(key);
  });
  nodeReads.set(key, flight);
  return flight;
}

/** A remote slot file's text, or its last `tailBytes` bytes; missing or unreadable is empty. */
export async function readSlotTextThroughNode(
  vars: Pick<SlotVars, 'machine' | 'remoteRepo'>,
  file: string,
  timeout: number,
  tailBytes?: number,
): Promise<string> {
  const extra = tailBytes ? { tailBytes } : {};
  return ((await shareNodeRead(vars, 'fs.readText', file, timeout, extra)) as NodeFsReadTextResult)
    .content;
}

/** `[ -f file ]` on a remote slot, answered by its node. */
export async function slotIsFileThroughNode(
  vars: Pick<SlotVars, 'machine' | 'remoteRepo'>,
  file: string,
  timeout: number,
): Promise<boolean> {
  return ((await shareNodeRead(vars, 'fs.isFile', file, timeout)) as NodeFsIsFileResult).isFile;
}
