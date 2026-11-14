import type { Run } from '@farmslot/protocol';

import { loadMachinePool, type SlotVars } from '../core/config.js';

import { getRunnerDefinition } from './registry.js';

/** Execution metadata only. Callers retain authorization for worker control operations. */
export async function reviewWorkspaceRunnerVars(run: Run): Promise<SlotVars | null> {
  const context = run.agentContexts?.find((entry) => entry.id === 'review');
  if (!context?.target?.session) return null;
  return reviewWorkspaceExecutionVars(run);
}

/** File and execution metadata for either transport; an absent terminal session stays absent. */
export async function reviewWorkspaceExecutionVars(run: Run): Promise<SlotVars | null> {
  const workspace = run.reviewWorkspace;
  const context = run.agentContexts?.find((entry) => entry.id === 'review');
  if (!workspace || !context) return null;
  const pool = await loadMachinePool(workspace.machine);
  const runnerObservabilityDir = getRunnerDefinition(context.runner).reviewObservabilityDir?.(
    workspace.taskPath,
  );
  return {
    slotId: `review-${workspace.workspaceId}`,
    machine: workspace.machine,
    platform: pool.platform,
    host: pool.host,
    sshUser: pool.ssh_user,
    osType: pool.os || 'darwin',
    claudePath: pool.claude_path || 'claude',
    codexPath: pool.codex_path || 'codex',
    cursorPath: pool.cursor_path || 'cursor-agent',
    grokPath: pool.grok_path || 'grok',
    opencodePath: pool.opencode_path || 'opencode',
    piPath: pool.pi_path,
    dispatchCmd: '',
    recycleCmd: '',
    repo: workspace.checkoutPath,
    remoteRepo: workspace.checkoutPath,
    session: context.target?.session ?? '',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: `${pool.ssh_user}@${pool.host}`,
    projectName: run.project,
    ...(runnerObservabilityDir ? { runnerObservabilityDir } : {}),
    resourceVars: {},
  };
}
