import type { Run, SlotAgentTargetParams } from '@farmslot/protocol';

import { execFileArgv, isLocal } from '../core/exec.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { execNativeNodeArgv } from '../runners/native/node.js';
import { reviewTmuxOperation, reviewTmuxSession } from '../runners/review-tmux.js';
import { getRun } from '../runs/store.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

export function isWorkspaceTerminal(
  params: Pick<SlotAgentTargetParams, 'slotId' | 'runId'>,
): boolean {
  return !params.slotId && Boolean(params.runId);
}

export function workspaceTerminalKey(runId: string): string {
  return `workspace:${runId}`;
}

export async function resolveWorkspaceTerminal(params: SlotAgentTargetParams) {
  if (
    params.slotId ||
    !params.runId ||
    params.role ||
    params.contextId ||
    params.target ||
    params.bareSession
  )
    throw new Error('Worktree terminals require only a run ID');
  const run = getRun(params.runId);
  if (!run?.reviewWorkspace || run.slotId !== null || run.reviewWorkspace.cleanedAt)
    throw new Error('The review worktree is no longer available');
  assertNativeRunOwner(run);
  const pools = await loadPoolConfigs();
  const pool = pools.find((entry) => entry.machine === run.reviewWorkspace!.machine);
  if (!pool) throw new Error('Review worktree machine is unavailable');
  const local = isLocal(pool.host, pool.machine);
  if ((local ? 'local' : pool.machine) !== run.reviewWorkspace.executionNodeId)
    throw new Error('Review worktree execution node changed');
  return {
    run,
    key: workspaceTerminalKey(run.id),
    session: run.transport === 'tmux' ? reviewTmuxSession(run) : sessionName(run),
    sshTarget: local ? undefined : `${pool.sshUser}@${pool.host}`,
  };
}

function sessionName(run: Run): string {
  const id = run.reviewWorkspace!.workspaceId;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid review workspace identity');
  return `review-shell-${id}`;
}

// Create/inspect the exact owned shell on the execution node. User input still uses
// the existing terminal PTY; no runner process or app slot is allocated here.
const script = String.raw`
const fs=require('node:fs'),cp=require('node:child_process');
const input=JSON.parse(process.argv[1]),target=input.session;
const tmux=(args)=>cp.spawnSync('tmux',args,{encoding:'utf8'});
const checked=(result)=>{if(result.status!==0)throw Error(result.stderr||result.error?.message||'tmux operation failed');return result.stdout.trim();};
const found=tmux(['has-session','-t','='+target]);
if(found.status!==0&&found.status!==1)checked(found);
if(input.action==='ensure'){
 if(!fs.statSync(input.cwd).isDirectory())throw Error('Review checkout is unavailable');
 if(found.status===1)checked(tmux(['new-session','-d','-s',input.session,'-c',input.cwd,';','set-option','-t',target,'@farmslot-review-workspace',input.workspaceId]));
}
if(found.status===1&&input.action!=='ensure'){process.stdout.write('[]');process.exit(0);}
if(checked(tmux(['show-option','-v','-t',target,'@farmslot-review-workspace']))!==input.workspaceId)throw Error('Review shell ownership changed');
if(input.action==='stop')checked(tmux(['kill-session','-t',target]));
else if(input.action==='snapshot')process.stdout.write(JSON.stringify(checked(tmux(['capture-pane','-p','-J','-t',target,'-S','-'+input.lines])).split('\n')));
else if(input.action==='send'){
 checked(tmux(['send-keys','-t',target,'-l',input.text]));
 if(input.enter)checked(tmux(['send-keys','-t',target,'Enter']));
}
`;

export async function workspaceTerminalOperation(
  run: Run,
  action: 'ensure' | 'stop' | 'snapshot' | 'send',
  input: { lines?: number; text?: string; enter?: boolean } = {},
) {
  assertNativeRunOwner(run);
  if (run.transport === 'tmux' && action === 'ensure') {
    if (!(await reviewTmuxOperation(run, 'inspect')).exists)
      throw new Error('The reviewer terminal has not started yet');
    return [];
  }
  if (run.transport === 'tmux' && action === 'stop') return [];
  const workspace = run.reviewWorkspace!;
  const argv = [
    'node',
    '-e',
    script,
    JSON.stringify({
      action,
      session: run.transport === 'tmux' ? reviewTmuxSession(run) : sessionName(run),
      workspaceId: workspace.workspaceId,
      cwd: workspace.checkoutPath,
      ...input,
    }),
  ];
  const result =
    workspace.executionNodeId === 'local'
      ? await execFileArgv([process.execPath, ...argv.slice(1)], { timeout: 10000 })
      : await execNativeNodeArgv(run.nativeOwnerPrincipalId!, workspace.machine, argv, 10000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Review shell operation failed');
  if (action !== 'stop') {
    const current = getRun(run.id);
    if (
      !current?.reviewWorkspace ||
      current.reviewWorkspace.cleanedAt ||
      current.reviewWorkspace.workspaceId !== workspace.workspaceId
    ) {
      if (action === 'ensure') await workspaceTerminalOperation(run, 'stop');
      throw new Error('Review worktree closed while opening its terminal');
    }
  }
  return action === 'snapshot' ? (JSON.parse(result.stdout) as string[]) : [];
}
