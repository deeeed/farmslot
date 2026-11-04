import { randomUUID } from 'node:crypto';

import type {
  ExecResult,
  NodeTmuxPane,
  TmuxWorkerCreateSessionParams,
  TmuxWorkerCreateSessionResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { resolveMachinePoolConfig } from '../fleet/machine-pool.js';
import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { publishWorkerResources } from '../resources/worker-changes.js';
import { createTmuxSessionArgv, endTmuxSessionArgv } from '../runtime/tmux-session-control.js';

import { tmuxWorkerAllowedByConfig, tmuxWorkerFromNodePane } from './tmux-workers.js';

/** Admin-only creation of a fresh shell. It never attaches to or replaces managed work. */
export async function tmuxWorkerCreateSession(
  params: TmuxWorkerCreateSessionParams,
): Promise<TmuxWorkerCreateSessionResult> {
  if (
    !params ||
    typeof params.nodeId !== 'string' ||
    !params.nodeId.trim() ||
    Object.keys(params).some((key) => key !== 'nodeId')
  )
    throw new GatewayMethodError('INVALID_PARAMS', 'Choose a terminal machine');
  const pools = await loadPoolConfigs();
  const pool = resolveMachinePoolConfig(pools, params.nodeId);
  const node = getNode(params.nodeId);
  if (!pool || !node)
    throw new GatewayMethodError('NODE_UNAVAILABLE', 'Terminal machine is not connected');
  const session = 'cc-terminal-' + randomUUID();
  const result = (await sendNodeRequest(
    node,
    'exec',
    { argv: createTmuxSessionArgv(session), timeout: 10_000 },
    { timeout: 15_000, requireSameConnection: true },
  )) as ExecResult;
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Could not create terminal');
  const value: unknown = JSON.parse(result.stdout);
  if (
    !value ||
    typeof value !== 'object' ||
    !('session' in value) ||
    value.session !== session ||
    !('paneId' in value) ||
    typeof value.paneId !== 'string' ||
    !/^%\d+$/.test(value.paneId) ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !('window' in value) ||
    typeof value.window !== 'string' ||
    !('pane' in value) ||
    typeof value.pane !== 'string' ||
    !('cwd' in value) ||
    typeof value.cwd !== 'string' ||
    !('windowName' in value) ||
    typeof value.windowName !== 'string' ||
    !('title' in value) ||
    typeof value.title !== 'string' ||
    !('command' in value) ||
    typeof value.command !== 'string'
  )
    throw new Error(
      'Terminal creation returned an invalid identity; check the session list before retrying',
    );
  const pane: NodeTmuxPane = {
    session,
    window: value.window,
    pane: value.pane,
    paneId: value.paneId,
    target: value.paneId,
    pid: value.pid,
    cwd: value.cwd,
    windowName: value.windowName,
    title: value.title,
    command: value.command,
  };
  const summary = tmuxWorkerFromNodePane({ nodeId: params.nodeId, pane, observedAt: Date.now() });
  if (!tmuxWorkerAllowedByConfig(pool.tmuxWorkers, summary)) {
    const cleanup = (await sendNodeRequest(
      node,
      'exec',
      {
        argv: endTmuxSessionArgv({ worker: summary.ref, expectedPid: value.pid }),
        timeout: 10_000,
      },
      { timeout: 15_000, requireSameConnection: true },
    )) as ExecResult;
    if (cleanup.exitCode !== 0)
      throw new Error('Machine policy hides the created terminal and cleanup failed: ' + session);
    throw new Error('Machine policy excludes new terminal sessions');
  }
  publishWorkerResources(params.nodeId);
  return { worker: summary.ref, pid: value.pid };
}
