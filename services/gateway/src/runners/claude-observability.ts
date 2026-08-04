import { resolveTmuxPaneId } from '../core/tmux.js';

import { readSlotClockMs } from './observability-clock.js';
import {
  activeToolFromHooks,
  contextPctFromStatusline,
  deriveRunnerActivity,
  deriveRunnerSessionDeliveryState,
  filterHooksByPane,
  filterStatuslineByPane,
  hookRecordMatchesRunnerSession,
  hookRecordMatchesRunnerSessionIdentity,
  lastTurnCompletedFromHooks,
  parseHookJsonl,
  parseStatuslineJson,
  promptAcceptedFromHooks,
  promptDigestMatchedFromHooks,
  readRunnerObservabilityFiles,
  readRunnerPaneObservabilityState,
  readRunnerSessionObservabilityState,
} from './observability-files.js';
import type { RunnerObservability, SlotVars } from './observability-types.js';

async function loadObservabilitySnapshot(vars: SlotVars, target: string) {
  const { hooksRaw, statuslineRaw } = await readRunnerObservabilityFiles(vars);
  const paneId = await resolveTmuxPaneId(vars, target);
  const hooks = filterHooksByPane(parseHookJsonl(hooksRaw), paneId);
  const statusline = filterStatuslineByPane(parseStatuslineJson(statuslineRaw), paneId);
  return { hooks, statusline };
}

export async function claudeSessionPaneMoveIsSafe(
  vars: SlotVars,
  recordedPane: string | null | undefined,
  destinationPane: string,
  resolvePane: typeof resolveTmuxPaneId = resolveTmuxPaneId,
): Promise<boolean> {
  if (!recordedPane || recordedPane === destinationPane) return true;
  return (await resolvePane(vars, recordedPane)) !== recordedPane;
}

export const claudeHookObservability: RunnerObservability = {
  promptAcceptanceMode: 'hook-digest',
  async getActivity(vars, target) {
    const { hooks, statusline } = await loadObservabilitySnapshot(vars, target);
    return deriveRunnerActivity(hooks, statusline);
  },

  async getContextPct(vars, target) {
    const { statusline } = await loadObservabilitySnapshot(vars, target);
    return contextPctFromStatusline(statusline);
  },

  async activeTool(vars, target) {
    const { hooks } = await loadObservabilitySnapshot(vars, target);
    return activeToolFromHooks(hooks);
  },

  async lastTurnCompletedAt(vars, target) {
    const { hooks } = await loadObservabilitySnapshot(vars, target);
    return lastTurnCompletedFromHooks(hooks);
  },

  async capturePromptAcceptanceBaseline(vars) {
    return readSlotClockMs(vars);
  },

  async promptAccepted(vars, target, promptDigest, sinceMs, paneRetired = false) {
    const { hooks } = await loadObservabilitySnapshot(vars, target);
    const reading = promptAcceptedFromHooks(
      hooks,
      promptDigest,
      sinceMs,
      500,
      Date.now(),
      undefined,
      paneRetired,
    );
    return reading
      ? {
          ...reading,
          exactPromptMatch: promptDigestMatchedFromHooks(hooks, promptDigest, sinceMs),
        }
      : null;
  },

  async getSessionDeliveryState(vars, target, sessionId, sessionPath) {
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const expected = { sessionId, sessionPath, paneId };
    const [sessionState, paneState] = await Promise.all([
      readRunnerSessionObservabilityState(vars, sessionId),
      readRunnerPaneObservabilityState(vars, paneId),
    ]);
    if (!hookRecordMatchesRunnerSessionIdentity(sessionState, expected)) {
      return null;
    }
    if (!(await claudeSessionPaneMoveIsSafe(vars, sessionState.tmuxPane, paneId))) {
      // A pane move is safe only after the pane that last owned the session is
      // gone. Otherwise resuming the transcript here would create two live
      // runners writing the same persisted session.
      return null;
    }
    // A freshly restored canonical worker window has no pane-scoped record yet.
    // Once the old pane is gone, the exact session-level Stop is authoritative
    // proof that the persisted session is safe to resume in the new pane.
    if (paneState && !hookRecordMatchesRunnerSession(paneState, expected)) {
      return null;
    }
    return deriveRunnerSessionDeliveryState(sessionState, sessionId);
  },
};
