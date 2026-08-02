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
  lastTurnCompletedFromHooks,
  parseHookJsonl,
  parseStatuslineJson,
  promptAcceptedFromHooks,
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
    return promptAcceptedFromHooks(
      hooks,
      promptDigest,
      sinceMs,
      500,
      Date.now(),
      undefined,
      paneRetired,
    );
  },

  async getSessionDeliveryState(vars, target, sessionId, sessionPath) {
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const expected = { sessionId, sessionPath, paneId };
    const [sessionState, paneState] = await Promise.all([
      readRunnerSessionObservabilityState(vars, sessionId),
      readRunnerPaneObservabilityState(vars, paneId),
    ]);
    if (
      !hookRecordMatchesRunnerSession(sessionState, expected) ||
      !hookRecordMatchesRunnerSession(paneState, expected)
    ) {
      return null;
    }
    return deriveRunnerSessionDeliveryState(sessionState, sessionId);
  },
};
