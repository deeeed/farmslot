import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CopilotCheckoutIdentity } from '@farmslot/protocol';

const execFileAsync = promisify(execFile);

export async function inspectCopilotCheckout(checkout: string): Promise<CopilotCheckoutIdentity> {
  const [{ stdout: branchOut }, { stdout: headOut }, { stdout: statusOut }] = await Promise.all([
    execFileAsync('git', ['branch', '--show-current'], { cwd: checkout }),
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkout }),
    execFileAsync('git', ['status', '--porcelain=v1'], { cwd: checkout }),
  ]);
  const dirtyPaths = statusOut
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  return {
    path: checkout,
    branch: branchOut.trim() || '(detached)',
    head: headOut.trim(),
    dirtyFileCount: dirtyPaths.length,
    dirtyPaths,
  };
}
