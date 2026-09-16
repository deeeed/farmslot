import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { nativeRunnerDefinitions } from '@farmslot/agent-runtime/native/registry';
import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars } from '../core/config.js';
import { execFileArgv } from '../core/exec.js';
import { resolveProjectCommandEnv } from '../core/project-env.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { getAllRuns, getRun, persistRunNow } from '../runs/store.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

import { execNativeNodeArgv } from './native/node.js';
import {
  buildInteractiveRefinementRunnerCommand,
  workspaceTerminalSessionCreateArgv,
} from './launch-command.js';
import { getRunnerDefinition } from './registry.js';

/** Recover only a unique structured metadata match, never the newest unrelated conversation. */
export async function recoverReviewTmuxSession(run: Run, assertCurrent: () => void): Promise<void> {
  const context = run.agentContexts?.find((candidate) => candidate.id === 'review');
  if (
    run.transport !== 'tmux' ||
    !run.reviewWorkspace ||
    !context ||
    context.runnerSessionId ||
    getRunnerDefinition(context.runner).workspaceTerminalSession !== 'create-chat'
  )
    return;
  const startedAt = Date.parse(context.attemptStartedAt ?? context.startedAt ?? '');
  const completedAt = Date.parse(context.completedAt ?? run.completedAt ?? '');
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return;
  assertNativeRunOwner(run);
  const script = await readFile(
    new URL(
      '../../../../packages/agent-runtime/scripts/cursor-session-discovery.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  const argv = [
    'node',
    '-e',
    script,
    JSON.stringify({
      root: '~/.cursor/chats',
      cwd: run.reviewWorkspace.checkoutPath,
      startedAt,
      completedAt,
    }),
  ];
  const result =
    run.reviewWorkspace.executionNodeId === 'local'
      ? await execFileArgv([process.execPath, ...argv.slice(1)], { timeout: 30000 })
      : await execNativeNodeArgv(
          run.nativeOwnerPrincipalId!,
          run.reviewWorkspace.machine,
          argv,
          30000,
        );
  assertCurrent();
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Review session discovery failed');
  const recovered = JSON.parse(result.stdout) as { sessionId: string } | null;
  if (!recovered) return;
  await upsertAgentContext(run.id, 'review', {
    id: context.id,
    runnerSessionId: recovered.sessionId,
  });
  await persistRunNow(getRun(run.id)!, 'recover exact reviewer session');
}

async function reviewEnvironment(run: Run) {
  const w = run.reviewWorkspace!;
  const project = await loadProjectVars(run.project);
  return resolveProjectCommandEnv(project.projectJson, {
    domain: run.domain,
    overrides: w.support
      ? Object.fromEntries(
          Object.entries(w.support.environment).map(([k, v]) => [
            k,
            v.replaceAll('{{support}}', w.support!.path),
          ]),
        )
      : undefined,
  });
}

async function reserveReviewSession(run: Run): Promise<string | undefined> {
  const w = run.reviewWorkspace!;
  const argv = workspaceTerminalSessionCreateArgv(run.metrics.runner!, w.checkoutPath);
  if (!argv) return undefined;
  const resumeSessionId =
    run.repeatReviewContext?.session?.continuity === 'resumed'
      ? run.repeatReviewContext.session.priorSessionId
      : undefined;
  if (
    resumeSessionId &&
    getAllRuns().some(
      (other) =>
        other.id !== run.id &&
        !isTerminalRunStatus(other.status) &&
        other.agentContexts?.some((context) => context.runnerSessionId === resumeSessionId),
    )
  )
    throw new Error('The retained reviewer is busy in another run');
  const script = path.posix.join(
    w.taskPath,
    'inputs/runtime/node_modules/@farmslot/agent-runtime/scripts/review-session.cjs',
  );
  const args = [
    'node',
    script,
    JSON.stringify({
      runId: run.id,
      workspaceId: w.workspaceId,
      runner: run.metrics.runner,
      cwd: w.checkoutPath,
      task: w.taskPath,
      argv,
      resumeSessionId,
      environment: await reviewEnvironment(run),
    }),
  ];
  const result =
    w.executionNodeId === 'local'
      ? await execFileArgv([process.execPath, ...args.slice(1)], { timeout: 30000 })
      : await execNativeNodeArgv(run.nativeOwnerPrincipalId!, w.machine, args, 30000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Review session reservation failed');
  return JSON.parse(result.stdout).sessionId;
}

export function reviewTmuxSession(run: Run) {
  const id = run.reviewWorkspace!.workspaceId;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid review workspace identity');
  return `review-${id}`;
}

export async function reviewTmuxOperation(
  run: Run,
  action: 'launch' | 'inspect' | 'stop',
  prompt?: string,
): Promise<{ exists?: boolean; startedAt?: string; stopped?: boolean }> {
  assertNativeRunOwner(run);
  const w = run.reviewWorkspace!;
  const runner = run.metrics.runner!;
  const input: Record<string, unknown> = {
    action,
    runId: run.id,
    workspaceId: w.workspaceId,
    session: reviewTmuxSession(run),
    cwd: w.checkoutPath,
    task: w.taskPath,
  };
  if (action === 'launch') {
    const pool = (await loadPoolConfigs()).find((pool) => pool.machine === w.machine);
    if (!pool) throw new Error('Review machine is unavailable');
    const environment = await reviewEnvironment(run);
    const command = buildInteractiveRefinementRunnerCommand({
      runner,
      model: run.metrics.model,
      promptPath: path.posix.join(w.taskPath, '.terminal-prompt.txt'),
      repo: w.checkoutPath,
      effort: run.effort,
      trustWorkspace: true,
      resumeSessionId:
        run.agentContexts?.find((context) => context.id === 'review')?.runnerSessionId ?? undefined,
      safetyTier: 'dangerous',
    });
    if (!command) throw new Error('Runner does not support terminal review');
    Object.assign(input, {
      command,
      prompt,
      environment,
      support: w.support?.path,
      runtimeRoots: nativeRunnerDefinitions[runner]?.reviewRuntimeRoots?.({ HOME: '~' }) ?? [
        '~/.codex',
      ],
    });
  }
  const script = path.posix.join(
    w.taskPath,
    'inputs/runtime/node_modules/@farmslot/agent-runtime/scripts/review-terminal.cjs',
  );
  const argv = ['node', script, JSON.stringify(input)];
  const result =
    w.executionNodeId === 'local'
      ? await execFileArgv([process.execPath, ...argv.slice(1)], { timeout: 30000 })
      : await execNativeNodeArgv(run.nativeOwnerPrincipalId!, w.machine, argv, 30000);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Review terminal operation failed');
  return JSON.parse(result.stdout);
}

export async function launchReviewTmux(
  runId: string,
  prompt: string,
  assertCurrent: () => Promise<unknown>,
) {
  await assertCurrent();
  const run = getRun(runId)!;
  const w = run.reviewWorkspace!;
  const session = reviewTmuxSession(run);
  const previous = run.agentContexts?.find((c) => c.id === 'review');
  if (previous?.nativeSession)
    throw new Error('Stop the native reviewer before changing execution transport');
  const runnerSessionId = previous?.runnerSessionId ?? (await reserveReviewSession(run));
  await assertCurrent();
  const patch = {
    id: 'review',
    label: 'Review',
    runner: run.metrics.runner,
    model: run.metrics.model,
    status: 'launching' as const,
    runnerSessionId,
    target: { session, target: session },
    taskFile: path.posix.join(w.taskPath, 'TASK.md'),
    signalFile: path.posix.join(w.taskPath, 'SIGNAL.json'),
    artifactScope: w.artifactPath,
    attemptStartedAt: previous?.attemptStartedAt ?? new Date().toISOString(),
  };
  const context = await upsertAgentContext(runId, 'review', patch, {
    resolvePatch: () => {
      // This predicate and the store update run synchronously inside the mutation queue.
      if (
        runnerSessionId &&
        getAllRuns().some(
          (other) =>
            other.id !== runId &&
            !isTerminalRunStatus(other.status) &&
            other.agentContexts?.some((context) => context.runnerSessionId === runnerSessionId),
        )
      )
        throw new Error('The retained reviewer is busy in another run');
      return patch;
    },
  });
  if (!context) throw new Error('Review context is unavailable');
  await persistRunNow(getRun(runId)!, 'terminal review launch intent');
  await assertCurrent();
  const started = await reviewTmuxOperation(getRun(runId)!, 'launch', prompt);
  await assertCurrent();
  await upsertAgentContext(runId, 'review', {
    id: 'review',
    status: 'working',
    promptDeliveryStartedAt: started.startedAt ?? context.attemptStartedAt,
  });
  await persistRunNow(getRun(runId)!, 'terminal review launched');
  return { session };
}
