import path from 'node:path';

import { nativeRunnerDefinitions } from '@farmslot/agent-runtime/native/registry';
import type { Run } from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars } from '../core/config.js';
import { execFileArgv } from '../core/exec.js';
import { resolveProjectCommandEnv } from '../core/project-env.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { getRun, persistRunNow } from '../runs/store.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

import { execNativeNodeArgv } from './native/node.js';
import { buildInteractiveRefinementRunnerCommand } from './launch-command.js';

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
    const project = await loadProjectVars(run.project);
    const pool = (await loadPoolConfigs()).find((pool) => pool.machine === w.machine);
    if (!pool) throw new Error('Review machine is unavailable');
    const environment = resolveProjectCommandEnv(project.projectJson, {
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
    const command = buildInteractiveRefinementRunnerCommand({
      runner,
      model: run.metrics.model,
      promptPath: path.posix.join(w.taskPath, '.terminal-prompt.txt'),
      repo: w.checkoutPath,
      effort: run.effort,
      trustWorkspace: true,
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
  const context = await upsertAgentContext(runId, 'review', {
    id: 'review',
    label: 'Review',
    runner: run.metrics.runner,
    model: run.metrics.model,
    status: 'launching',
    target: { session, target: session },
    taskFile: path.posix.join(w.taskPath, 'TASK.md'),
    signalFile: path.posix.join(w.taskPath, 'SIGNAL.json'),
    artifactScope: w.artifactPath,
    attemptStartedAt: previous?.attemptStartedAt ?? new Date().toISOString(),
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
