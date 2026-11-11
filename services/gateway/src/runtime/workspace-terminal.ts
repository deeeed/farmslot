import { randomUUID } from 'node:crypto';

import type { Run, SlotAgentTargetParams } from '@farmslot/protocol';

import { execFileArgv, isLocal } from '../core/exec.js';
import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { shellQuote } from '../core/tmux.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { resolveReviewWorkspacePool } from '../review-workspaces/pool.js';
import { execNativeNodeArgv } from '../runners/native/node.js';
import {
  assertRunnerPromptSent,
  captureRunnerPromptAcceptanceBaseline,
  getRunnerObservability,
  sendRunnerPrompt,
  submitRunnerPrompt,
} from '../runners/registry.js';
import { reviewWorkspaceRunnerVars } from '../runners/review-startup.js';
import { reviewTmuxOperation, reviewTmuxSession } from '../runners/review-tmux.js';
import { getRun } from '../runs/store.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

import { type PaneInputRecord, tmuxPaneInputRecord } from './terminal-input-sequence.js';

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
  if (run.reviewWorkspace.retirement)
    throw new Error('The review worktree is being reclaimed after retention expiry');
  assertNativeRunOwner(run);
  const pools = await loadPoolConfigs();
  const pool = resolveReviewWorkspacePool(pools, run.reviewWorkspace.machine, run.project);
  const local = isLocal(pool.host, pool.machine);
  if ((local ? 'local' : pool.machine) !== run.reviewWorkspace.executionNodeId)
    throw new Error('Review worktree execution node changed');
  return {
    run,
    key: workspaceTerminalKey(run.id),
    session: run.transport === 'tmux' ? reviewTmuxSession(run) : reviewWorkspaceShellSession(run),
    sshTarget: local ? undefined : `${pool.sshUser}@${pool.host}`,
  };
}

export function reviewWorkspaceShellSession(run: Run): string {
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

/** The review shell pane's input record, read and written through the run owner's node. */
export function workspacePaneInputRecord(run: Run, session: string): PaneInputRecord {
  assertNativeRunOwner(run);
  const workspace = run.reviewWorkspace!;
  return tmuxPaneInputRecord(session, (command) =>
    workspace.executionNodeId === 'local'
      ? execFileArgv(['bash', '-c', command], { timeout: 5_000 })
      : execNativeNodeArgv(
          run.nativeOwnerPrincipalId!,
          workspace.machine,
          ['bash', '-c', command],
          5_000,
        ),
  );
}

/** Keep shared runner observations and input on the review owner's transport. */
export function withReviewWorkspaceExecutor<T>(run: Run, operation: () => Promise<T>): Promise<T> {
  assertNativeRunOwner(run);
  const workspace = structuredClone(run.reviewWorkspace);
  if (!workspace) throw new Error('Review workspace is unavailable');
  const { workspaceId, machine, executionNodeId } = workspace;
  const owner = run.nativeOwnerPrincipalId;
  const generation = run.engineState?.generation ?? 0;
  return withSlotCommandExecutor(async (target, command, options) => {
    const current = getRun(run.id);
    if (
      !current?.reviewWorkspace ||
      current.reviewWorkspace.cleanedAt ||
      current.reviewWorkspace.workspaceId !== workspaceId ||
      current.reviewWorkspace.machine !== machine ||
      current.reviewWorkspace.executionNodeId !== executionNodeId ||
      current.nativeOwnerPrincipalId !== owner ||
      (current.engineState?.generation ?? 0) !== generation ||
      current.reviewWorkspace.checkoutPath !== workspace.checkoutPath ||
      current.reviewWorkspace.taskPath !== workspace.taskPath ||
      target.machine !== machine
    )
      throw new Error('Review workspace authority changed before runner input');
    assertNativeRunOwner(current);
    if (executionNodeId === 'local') return execFileArgv(['bash', '-c', command], options);
    const body = `cd ${shellQuote(options.cwd ?? target.remoteRepo)} && ${command}`;
    if (!owner) throw new Error('Remote review workspace has no owner');
    return execNativeNodeArgv(owner, machine, ['bash', '-c', body], options.timeout ?? 10000);
  }, operation);
}

export async function workspaceTerminalOperation(
  run: Run,
  action: 'ensure' | 'stop' | 'snapshot' | 'send',
  input: { lines?: number; text?: string; enter?: boolean } = {},
) {
  assertNativeRunOwner(run);
  if (action !== 'stop' && run.reviewWorkspace?.retirement)
    throw new Error('The review worktree is being reclaimed after retention expiry');
  if (run.transport === 'tmux' && action === 'ensure') {
    if (!(await reviewTmuxOperation(run, 'inspect')).exists)
      throw new Error('The reviewer terminal has not started yet');
    return [];
  }
  if (run.transport === 'tmux' && action === 'stop') return [];
  const workspace = run.reviewWorkspace!;
  const { machine } = workspace;
  const owner = run.nativeOwnerPrincipalId;
  const semanticSend = run.transport === 'tmux' && action === 'send' && input.enter !== false;
  const argv = [
    'node',
    '-e',
    script,
    JSON.stringify({
      action: semanticSend ? 'inspect' : action,
      session: run.transport === 'tmux' ? reviewTmuxSession(run) : reviewWorkspaceShellSession(run),
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
  if (semanticSend) {
    const vars = await reviewWorkspaceRunnerVars(run);
    const context = run.agentContexts?.find((entry) => entry.id === 'review');
    const runner = context?.runner;
    if (!vars || !runner || vars.session !== reviewTmuxSession(run))
      throw new Error('The owning reviewer runner context is unavailable; no input was sent');
    const retainedSession =
      context?.runnerSessionId && context.runnerSessionPath
        ? { sessionId: context.runnerSessionId, sessionPath: context.runnerSessionPath }
        : undefined;
    await withReviewWorkspaceExecutor(run, async () => {
      if (run.reviewWorkspace?.retainedAt && run.reviewResult) {
        const observer = getRunnerObservability(runner);
        if (
          !retainedSession ||
          !observer?.promptAcceptedInSession ||
          !observer.getSessionDeliveryState
        )
          throw new Error('Retained reviewer input requires its exact observable conversation');
        const since = await captureRunnerPromptAcceptanceBaseline(vars, vars.session, runner);
        if (since === null) throw new Error('Retained reviewer input has no acceptance baseline');
        if (!owner) throw new Error('Retained reviewer input has no owner');
        const { admitReviewWorkspaceFollowup, settleReviewWorkspaceFollowups } =
          await import('../review-workspaces/admission.js');
        const commandId = randomUUID();
        await admitReviewWorkspaceFollowup(run.id, commandId, {
          ...retainedSession,
          message: input.text ?? '',
          since,
        });
        const outcome = await submitRunnerPrompt(vars, vars.session, runner, input.text ?? '', {
          retainedSession,
        });
        if (outcome === 'held-untouched')
          await settleReviewWorkspaceFollowups(machine, owner, undefined, {
            runId: run.id,
            commandId,
          });
        assertRunnerPromptSent(outcome);
        return;
      }
      await sendRunnerPrompt(vars, vars.session, runner, input.text ?? '', { retainedSession });
    });
  }
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
