import { resolveTmuxPaneId } from '../core/tmux.js';

import {
  activeToolFromHooks,
  contextPctFromStatusline,
  deriveRunnerActivity,
  filterHooksByPane,
  filterStatuslineByPane,
  lastTurnCompletedFromHooks,
  parseHookJsonl,
  parseStatuslineJson,
  promptAcceptedFromHooks,
  promptDigestAcceptedFromHooks,
  readRunnerObservabilityFiles,
} from './observability-files.js';
import type { RunnerObservability, SlotVars } from './observability-types.js';

async function loadObservabilitySnapshot(vars: SlotVars, target: string) {
  const { hooksRaw, statuslineRaw } = await readRunnerObservabilityFiles(vars);
  const paneId = await resolveTmuxPaneId(vars, target);
  const allHooks = parseHookJsonl(hooksRaw);
  const hooks = filterHooksByPane(allHooks, paneId);
  const statusline = filterStatuslineByPane(parseStatuslineJson(statuslineRaw), paneId);
  return { allHooks, hooks, paneId, statusline };
}

export const claudeHookObservability: RunnerObservability = {
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

  async promptDigestAccepted(vars, target, promptDigest, sinceMs, paneRetired = false) {
    const { allHooks, paneId } = await loadObservabilitySnapshot(vars, target);
    return promptDigestAcceptedFromHooks(
      allHooks,
      promptDigest,
      sinceMs,
      Date.now(),
      paneId,
      paneRetired,
    );
  },
};
