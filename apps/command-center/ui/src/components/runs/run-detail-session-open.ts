import type {
  AgentRole,
  Run,
  RunSessionCommandResult,
  RunSessionLiveness,
  TmuxWorkerRestoreResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  runSessionCommandTextForKind,
  type RunSessionRow,
  shouldRestoreRunnerSessionOnHost,
} from './run-detail-session-renderers.js';

export interface OpenRunnerSessionOnHostResult {
  ok: boolean;
  restored: boolean;
  slotId: string | null;
  contextId: string;
  role: AgentRole;
  liveness?: RunSessionLiveness;
  machine?: string;
  tmuxTarget?: string | null;
  command?: string;
  message: string;
}

function locationFromResult(result: RunSessionCommandResult): {
  machine?: string;
  slotId: string | null;
  tmuxTarget?: string | null;
  command?: string;
  liveness?: RunSessionLiveness;
} {
  if (!result.supported) return { slotId: null };
  return {
    machine: result.machine,
    slotId: result.slotId,
    tmuxTarget: result.tmuxTarget,
    command: runSessionCommandTextForKind(result, 'reopen') ?? result.attachCommand ?? undefined,
    liveness: result.liveness,
  };
}

/**
 * Recover this agent context on the slot's node when needed, then hand the
 * caller the slot/context to open in the terminal view. The UI never SSHs and
 * never pastes runner CLI itself: `tmux.worker.restore` owns reload.
 */
export async function openRunnerSessionOnHost(input: {
  runId: string;
  runStatus?: Run['status'];
  row: Pick<RunSessionRow, 'contextId' | 'role' | 'slotId'>;
}): Promise<OpenRunnerSessionOnHostResult> {
  const failed = (message: string, extra: Partial<OpenRunnerSessionOnHostResult> = {}) => ({
    ok: false,
    restored: false,
    slotId: extra.slotId ?? input.row.slotId,
    contextId: input.row.contextId,
    role: input.row.role,
    message,
    ...extra,
  });

  let result: RunSessionCommandResult;
  try {
    result = await gateway.request<RunSessionCommandResult>(Methods.RUN_SESSION_COMMAND, {
      runId: input.runId,
      contextId: input.row.contextId,
      role: input.row.role,
    });
  } catch (err) {
    return failed((err as Error).message);
  }

  const location = locationFromResult(result);
  const slotId = location.slotId ?? input.row.slotId;
  if (!result.supported) return failed(result.detail, location);

  if (
    !shouldRestoreRunnerSessionOnHost({ liveness: result.liveness, runStatus: input.runStatus })
  ) {
    if (result.liveness === 'live') {
      return {
        ok: true,
        restored: false,
        contextId: input.row.contextId,
        role: input.row.role,
        ...location,
        slotId,
        message: `Opened live session on ${result.machine} · ${result.slotId}.`,
      };
    }
    return failed(`This run is finished. Copy the command and paste it on ${result.machine}.`, {
      ...location,
      slotId,
    });
  }

  if (!slotId) {
    return failed('No slot is bound to this session, so it cannot be opened on a host.', location);
  }

  try {
    const restored = await gateway.request<TmuxWorkerRestoreResult>(Methods.TMUX_WORKER_RESTORE, {
      slotId,
      runId: input.runId,
      contextId: input.row.contextId,
      mode: 'reload-session',
    });
    const restoredContext =
      restored.contexts.find((ctx) => ctx.contextId === input.row.contextId) ??
      restored.contexts[0];
    return {
      ok: true,
      restored: restored.restored,
      contextId: input.row.contextId,
      role: input.row.role,
      ...location,
      slotId,
      liveness: restoredContext?.status === 'live' || restored.restored ? 'live' : result.liveness,
      message:
        restoredContext?.detail ??
        (restored.restored
          ? `Reloaded the session on ${result.machine} · ${slotId}.`
          : `Opened the session on ${result.machine} · ${slotId}.`),
    };
  } catch (err) {
    return failed((err as Error).message, { ...location, slotId });
  }
}
