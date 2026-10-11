import { type ExecResult, remoteBranchRefspec } from '@farmslot/protocol';

import { shellQuote } from './tmux.js';

export type GitRemoteExec = (command: string) => Promise<ExecResult>;

export function fetchRemoteBranch(
  repo: string,
  remote: string,
  branch: string,
  exec: GitRemoteExec,
): Promise<ExecResult> {
  return exec(
    `git -C ${shellQuote(repo)} fetch --no-tags ${shellQuote(remote)} ${shellQuote(remoteBranchRefspec(branch, remote))}`,
  );
}

export interface RemoteBranchProbe {
  presence: 'present' | 'missing' | 'unknown';
  branches: string[];
  result: ExecResult;
}

/** Only Git's no-match exit proves absence. A transport failure proves nothing. */
export async function probeRemoteBranch(
  repo: string,
  remote: string,
  branch: string | string[],
  exec: GitRemoteExec,
): Promise<RemoteBranchProbe> {
  const result = await exec(
    `git -C ${shellQuote(repo)} ls-remote --exit-code --heads ${shellQuote(remote)} ${(Array.isArray(branch) ? branch : [branch]).map((name) => shellQuote(`refs/heads/${name}`)).join(' ')}`,
  );
  return {
    presence: result.exitCode === 0 ? 'present' : result.exitCode === 2 ? 'missing' : 'unknown',
    branches: result.stdout
      .trim()
      .split('\n')
      .flatMap((line) => {
        const name = line.split('\t')[1];
        return name?.startsWith('refs/heads/') ? [name.slice('refs/heads/'.length)] : [];
      }),
    result,
  };
}
