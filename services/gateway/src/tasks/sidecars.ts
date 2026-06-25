import { existsSync } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import path from 'node:path';

import { execLocal, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

export const CHECKLIST_MARKER_INPUT = 'mark';
export const TASK_ROOT_SIDECARS = [CHECKLIST_MARKER_INPUT] as const;

export interface CopyPreparedTaskRootSidecarsParams {
  taskDir: string;
  workerTaskAbs: string;
  host: string;
  machine: string;
  sshTarget?: string;
}

export async function copyPreparedTaskRootSidecars(
  params: CopyPreparedTaskRootSidecarsParams,
): Promise<string[]> {
  const copied: string[] = [];
  const local = isLocal(params.host, params.machine);

  for (const sidecar of TASK_ROOT_SIDECARS) {
    const source = path.join(params.taskDir, sidecar);
    if (!existsSync(source)) continue;

    const dest = path.join(params.workerTaskAbs, sidecar);
    if (local) {
      await copyFile(source, dest);
      await chmod(dest, 0o755);
    } else {
      if (!params.sshTarget) throw new Error(`missing ssh target for ${sidecar} sidecar copy`);
      const scpRes = await execLocal(
        `scp -q ${shellQuote(source)} ${shellQuote(`${params.sshTarget}:${dest}`)}`,
      );
      if (scpRes.exitCode !== 0) {
        throw new Error(
          `scp ${sidecar} to ${params.sshTarget}:${dest} failed: ${scpRes.stderr.trim() || scpRes.stdout.trim() || `exit ${scpRes.exitCode}`}`,
        );
      }
      const chmodRes = await execLocal(
        `ssh ${shellQuote(params.sshTarget)} ${shellQuote(`chmod 755 ${shellQuote(dest)}`)}`,
      );
      if (chmodRes.exitCode !== 0) {
        throw new Error(
          `chmod ${sidecar} on ${params.sshTarget}:${dest} failed: ${chmodRes.stderr.trim() || chmodRes.stdout.trim() || `exit ${chmodRes.exitCode}`}`,
        );
      }
    }

    copied.push(sidecar);
  }

  return copied;
}
