import path from 'node:path';

import { isLocal } from '../../core/exec.js';
import { slotFileExists, type SlotLocality, slotReadFile, slotStat } from '../../core/slot-io.js';
import { getNode } from '../../fleet/machine-registry.js';
import { NodeRpcTimeoutError, sendNodeRequest } from '../../fleet/node-rpc.js';

interface WorkspaceVersionSource extends SlotLocality {
  remoteRepo: string;
}

function relativeTo(directory: string, file: string): string {
  return path.posix.isAbsolute(file) || file.startsWith('~/')
    ? file
    : path.posix.join(directory, file);
}

/** Metadata for passive display reuse. Acting reads always run the full probe. */
export async function workspaceVersion(
  vars: WorkspaceVersionSource,
  defaultBranch: string,
): Promise<string | undefined> {
  let context: SlotLocality = vars;
  if (!isLocal(vars.host, vars.machine)) {
    const node = getNode(vars.machine);
    const request: SlotLocality['nodeRequest'] =
      vars.nodeRequest ??
      (node
        ? (method, params, options) => sendNodeRequest(node, method, params, options)
        : undefined);
    if (!request) return undefined;
    const deadline = Date.now() + 1000;
    context = {
      ...vars,
      nodeRequest: (method, params) => {
        const timeout = deadline - Date.now();
        if (timeout <= 0) return Promise.reject(new NodeRpcTimeoutError(vars.machine, 1000));
        return request(method, params, { timeout, requireSameConnection: true });
      },
    };
  }
  const marker = path.posix.join(vars.remoteRepo, '.git');
  if (!(await slotFileExists(context, marker))) return undefined;
  const markerStat = await slotStat(context, marker);
  if (!Number.isFinite(markerStat.mtimeMs)) return undefined;
  let gitDir = marker;
  if (markerStat.isFile) {
    const pointer = /^gitdir: (.+)$/.exec((await slotReadFile(context, marker)).trim());
    const target = pointer?.[1];
    if (!target) return undefined;
    gitDir = relativeTo(vars.remoteRepo, target);
  } else if (!markerStat.isDirectory) return undefined;
  const head = (await slotReadFile(context, path.posix.join(gitDir, 'HEAD'))).trim();
  // Reftable needs Git's ref resolver; do not guess its compatibility HEAD.
  if (head === 'ref: refs/heads/.invalid') return undefined;
  const commonFile = path.posix.join(gitDir, 'commondir');
  const commonDir = (await slotFileExists(context, commonFile))
    ? relativeTo(gitDir, (await slotReadFile(context, commonFile)).trim())
    : gitDir;
  const ref = /^ref: (refs\/.+)$/.exec(head)?.[1];
  const refFile = ref ? path.posix.join(commonDir, ref) : undefined;
  const refValue =
    refFile && (await slotFileExists(context, refFile))
      ? await slotReadFile(context, refFile)
      : null;
  const metadata = await Promise.all(
    [
      path.posix.join(gitDir, 'index'),
      path.posix.join(commonDir, 'packed-refs'),
      path.posix.join(commonDir, 'config'),
      path.posix.join(commonDir, 'refs/remotes/origin', defaultBranch),
      path.posix.join(gitDir, 'FETCH_HEAD'),
    ].map(async (file) => {
      if (!(await slotFileExists(context, file))) return null;
      const value = await slotStat(context, file);
      if (!Number.isFinite(value.mtimeMs)) throw new Error('Workspace metadata has no timestamp');
      return [value.mtimeMs, value.size];
    }),
  );
  return JSON.stringify([
    vars.machine,
    vars.remoteRepo,
    defaultBranch,
    gitDir,
    commonDir,
    markerStat.mtimeMs,
    markerStat.size,
    head,
    refValue,
    metadata,
  ]);
}
