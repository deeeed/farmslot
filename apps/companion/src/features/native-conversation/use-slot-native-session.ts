import { useEffect, useMemo, useState } from 'react';

import type { Run, SlotAgentTargetParams } from '@farmslot/protocol';
import { nativeRunConversationParams, slotSessionView } from '@farmslot/review-dispatch';

import { buildCompanionTerminalTarget } from '../../lib/terminal-target';

export function useSlotNativeSession(
  run: Run | null,
  slotId: string,
  requestedContextId?: string,
  runId?: string,
  options?: { role?: SlotAgentTargetParams['role']; bareSession: boolean },
) {
  const [selection, setSelection] = useState({ contextId: requestedContextId ?? '', tmux: false });
  const contextId = selection.contextId;
  const select = (id: string) => setSelection({ contextId: id, tmux: id === '' });
  useEffect(
    () => setSelection({ contextId: requestedContextId ?? '', tmux: false }),
    [requestedContextId, runId, slotId],
  );
  const { tabs, target, unavailable } = slotSessionView(run?.agentContexts ?? [], {
    slotId,
    contextId,
    tmux: selection.tmux,
  });
  const nativeRoute = tabs.some((tab) => tab.target.contextId === requestedContextId);
  const context = run?.agentContexts?.find((candidate) => candidate.id === target?.contextId);
  const params = run && context ? nativeRunConversationParams(run, context) : undefined;
  const terminalTarget = useMemo(
    () =>
      !unavailable && (slotId || runId) && (!requestedContextId || run)
        ? buildCompanionTerminalTarget({
            slotId,
            runId,
            contextId: target || selection.tmux ? undefined : contextId || undefined,
            role: target || nativeRoute || selection.tmux ? undefined : options?.role,
            bareSession: selection.tmux || (options?.bareSession ?? false),
          })
        : null,
    [
      slotId,
      runId,
      requestedContextId,
      Boolean(run),
      contextId,
      unavailable,
      selection.tmux,
      Boolean(target),
      nativeRoute,
      options?.role,
      options?.bareSession,
    ],
  );
  return {
    contextId,
    select,
    tabs,
    target,
    unavailable,
    params,
    terminalTarget,
    targetForBareSession: (bareSession: boolean) =>
      buildCompanionTerminalTarget({
        ...terminalTarget,
        slotId,
        runId,
        bareSession: bareSession || selection.tmux,
      }),
  };
}
