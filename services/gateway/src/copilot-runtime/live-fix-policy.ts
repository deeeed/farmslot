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

export function assertCopilotCommitAllowed(checkout: CopilotCheckoutIdentity): void {
  if (checkout.branch === 'main') {
    throw new Error('Co-Pilot refuses to commit on main; create or switch to a feature branch');
  }
}

export interface CopilotLiveFixHandoff {
  checkout: string;
  branch: string;
  head: string;
  dirtyPaths: string[];
  diff: string;
  validationCommands: string[];
  reviewHead: string;
}

export function buildLiveFixHandoff(input: {
  checkout: CopilotCheckoutIdentity;
  diff: string;
  validationCommands: string[];
  reviewHead: string;
}): CopilotLiveFixHandoff {
  assertCopilotCommitAllowed(input.checkout);
  if (input.reviewHead !== input.checkout.head) {
    throw new Error('Live-fix handoff review HEAD must equal the validated checkout HEAD');
  }
  return {
    checkout: input.checkout.path,
    branch: input.checkout.branch,
    head: input.checkout.head,
    dirtyPaths: [...input.checkout.dirtyPaths],
    diff: input.diff,
    validationCommands: [...input.validationCommands],
    reviewHead: input.reviewHead,
  };
}
