import { createHash } from 'node:crypto';
import path from 'node:path';

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
    (params.ref !== undefined && params.ref !== subject.headSha) ||
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
  return {
    runCommand: async (args) => {
      if (!['rev-parse', 'merge-base', 'branch', 'diff', 'show'].includes(args[0]))
        throw new Error('Review viewer only supports reading frozen Git data');
      const script = `const fs=require('node:fs'),cp=require('node:child_process');
const p=JSON.parse(process.argv[1]);
if(JSON.stringify(JSON.parse(fs.readFileSync(p.cache+'.json','utf8')))!==JSON.stringify(p.identity))throw Error('Review repository ownership changed');
const r=cp.spawnSync('git',['--no-pager','--git-dir',p.cache,...p.args],{encoding:'utf8',maxBuffer:10*1024*1024});
if(r.error)throw r.error;process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`;
      const argv = ['node', '-e', script, JSON.stringify({ cache, identity, args })];
      const result =
        workspace.executionNodeId === 'local'
          ? await execFileArgv([process.execPath, ...argv.slice(1)], {
              maxBuffer: 10 * 1024 * 1024,
            })
          : await execNativeNodeArgv(run.nativeOwnerPrincipalId!, workspace.machine, argv, 30_000);
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Review Git read failed');
      return result;
    },
  };
}
