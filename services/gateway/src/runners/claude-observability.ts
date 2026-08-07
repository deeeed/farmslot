import path from 'node:path';

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

export async function sessionPaneMoveIsSafe(
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
  async resolveSessionId(_vars, sessionPath) {
    const base = path.basename(sessionPath);
    return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base || null;
  },
  async getActivity(vars, target) {
    const { hooks, statusline } = await loadObservabilitySnapshot(vars, target);
    return deriveRunnerActivity(hooks, statusline);
  },

  async getTurnState(vars, target, expectedTurnToken) {
    if (expectedTurnToken) {
      const separator = expectedTurnToken.lastIndexOf(':');
      const expectedSessionId = separator > 0 ? expectedTurnToken.slice(0, separator).trim() : '';
      if (!expectedSessionId) return null;
      const paneId = await resolveTmuxPaneId(vars, target);
      if (!paneId) return null;
      const [sessionState, paneState] = await Promise.all([
        readRunnerSessionObservabilityState(vars, expectedSessionId),
        readRunnerPaneObservabilityState(vars, paneId),
      ]);
      if (sessionState?.session_id !== expectedSessionId) return null;
      if (!(await sessionPaneMoveIsSafe(vars, sessionState.tmuxPane, paneId))) return null;
      if (paneState?.rootSessionId && paneState.rootSessionId !== expectedSessionId) return null;
      return deriveRunnerSessionDeliveryState(sessionState, expectedSessionId);
    }
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const paneState = await readRunnerPaneObservabilityState(vars, paneId);
    const sessionId = paneState?.session_id;
    if (!sessionId) return null;
    return deriveRunnerSessionDeliveryState(paneState, sessionId);
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
    if (!(await sessionPaneMoveIsSafe(vars, sessionState.tmuxPane, paneId))) {
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
