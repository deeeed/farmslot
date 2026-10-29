import { createHash } from 'node:crypto';
import path from 'node:path';

import { gitDiffArgs } from '@farmslot/agent-runtime/scripts/git-diff.cjs';

import { execFileArgv } from '../core/exec.js';
import type { GitExecDeps } from '../methods/git.js';
import { execNativeNodeArgv } from '../runners/native/node.js';
import { getRunWithArchived } from '../runs/store.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

/** Existing diff/code viewers read the frozen commits, even after checkout cleanup. */
export async function workspaceReviewGit(params: {
  runId: string;
  slotId: string;
  base?: string;
  head?: string;
  ref?: string;
  target?: string;
  /** Batched content may also read the merge-base derived from the frozen commits. */
  mergeBaseRef?: boolean;
}): Promise<GitExecDeps> {
  if (params.slotId) throw new Error('Choose a slot or a review run, not both');
  const run = await getRunWithArchived(params.runId);
  if (!run?.reviewWorkspace || !run.reviewWorkspaceSubject)
    throw new Error('Review source is unavailable');
  assertNativeRunOwner(run);
  const subject = run.reviewWorkspaceSubject;
  if (
    (params.base !== undefined && params.base !== subject.baseSha) ||
    (params.head !== undefined && params.head !== subject.headSha) ||
    (params.ref !== undefined && params.ref !== subject.headSha && !params.mergeBaseRef) ||
    params.target === 'worktree' ||
    (!params.ref && (!params.base || !params.head))
  )
    throw new Error('Review viewer must use the frozen review commits');
  const identity = {
    owner: run.nativeOwnerPrincipalId,
    project: run.project,
    repositoryUrl: subject.repositoryUrl,
  };
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const cache = path.posix.join(
    path.posix.dirname(path.posix.dirname(path.posix.dirname(run.reviewWorkspace.checkoutPath))),
    'repositories',
    key,
  );
  const workspace = run.reviewWorkspace;
  // Bytes reads leave the host as base64, as text-decoding exec paths require.
  const runGit = async (args: string[], bytes?: { input: string; maxBuffer: number }) => {
    const maxBuffer = bytes?.maxBuffer ?? 10 * 1024 * 1024;
    const script = `const fs=require('node:fs'),cp=require('node:child_process');
const p=JSON.parse(process.argv[1]);
if(JSON.stringify(JSON.parse(fs.readFileSync(p.cache+'.json','utf8')))!==JSON.stringify(p.identity))throw Error('Review repository ownership changed');
const r=cp.spawnSync('git',['--no-pager','--git-dir',p.cache,...p.args],{input:p.input,maxBuffer:p.maxBuffer});
if(r.error)throw r.error;process.stdout.write(r.stdout.toString(p.base64?'base64':'utf8'));process.stderr.write(r.stderr);process.exitCode=r.status??1;`;
    const argv = [
      'node',
      '-e',
      script,
      JSON.stringify({
        cache,
        identity,
        args: args[0] === 'diff' ? gitDiffArgs(args.slice(1)) : args,
        input: bytes?.input,
        maxBuffer,
        base64: bytes !== undefined,
      }),
    ];
    const result =
      workspace.executionNodeId === 'local'
        ? await execFileArgv([process.execPath, ...argv.slice(1)], {
            maxBuffer: bytes ? Math.ceil(maxBuffer / 3) * 4 + 64 * 1024 : maxBuffer,
          })
        : await execNativeNodeArgv(run.nativeOwnerPrincipalId!, workspace.machine, argv, 30_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Review Git read failed');
    return result;
  };
  const deps: GitExecDeps = {
    runCommand: async (args) => {
      if (!['rev-parse', 'merge-base', 'branch', 'diff', 'show'].includes(args[0]))
        throw new Error('Review viewer only supports reading frozen Git data');
      return runGit(args);
    },
    runBytes: async (args, input, maxBuffer) => {
      if (args[0] !== 'cat-file')
        throw new Error('Review viewer only supports reading frozen Git data');
      return Buffer.from((await runGit(args, { input, maxBuffer })).stdout, 'base64');
    },
  };
  if (params.ref !== undefined && params.ref !== subject.headSha) {
    // Derived here, after the owner and repository checks, never taken from the client.
    const { stdout } = await runGit(['merge-base', subject.baseSha, subject.headSha]);
    if (params.ref !== stdout.trim())
      throw new Error('Review viewer must use the frozen review commits');
  }
  return deps;
}
