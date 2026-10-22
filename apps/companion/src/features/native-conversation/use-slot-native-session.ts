import { useEffect, useMemo, useState } from 'react';

import type { Run, SlotAgentTargetParams } from '@farmslot/protocol';
import { nativeRunConversationParams, nativeWorkerTabs } from '@farmslot/review-dispatch';

import { buildCompanionTerminalTarget } from '../../lib/terminal-target';

export function useSlotNativeSession(
  run: Run | null,
  slotId: string,
  requestedContextId?: string,
  runId?: string,
  options?: { role?: SlotAgentTargetParams['role']; bareSession: boolean },
) {
  const [contextId, select] = useState(requestedContextId ?? '');
  useEffect(() => select(requestedContextId ?? ''), [requestedContextId, runId, slotId]);
  const tabs = nativeWorkerTabs(run?.agentContexts ?? [], slotId || undefined);
  const target = tabs.find((tab) => tab.target.contextId === contextId)?.target;
  const nativeRoute = tabs.some((tab) => tab.target.contextId === requestedContextId);
  const context = run?.agentContexts?.find((candidate) => candidate.id === target?.contextId);
  const params = run && context ? nativeRunConversationParams(run, context) : undefined;
  const terminalTarget = useMemo(
    () =>
      (slotId || runId) && (!requestedContextId || run)
        ? buildCompanionTerminalTarget({
            slotId,
            runId,
            contextId: target ? undefined : contextId || undefined,
            role: target || nativeRoute ? undefined : options?.role,
            bareSession: options?.bareSession ?? false,
          })
        : null,
    [
      slotId,
      runId,
      requestedContextId,
      Boolean(run),
      contextId,
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
    params,
    terminalTarget,
    targetForBareSession: (bareSession: boolean) =>
      buildCompanionTerminalTarget({ ...terminalTarget, slotId, runId, bareSession }),
  };
}
