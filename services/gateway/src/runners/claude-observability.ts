import {
  activeToolFromHooks,
  contextPctFromStatusline,
  deriveRunnerActivity,
  lastTurnCompletedFromHooks,
  parseHookJsonl,
  parseStatuslineJson,
  readRunnerObservabilityFiles,
} from './observability-files.js';
import type { RunnerObservability, SlotVars } from './observability-types.js';

async function loadObservabilitySnapshot(vars: SlotVars) {
  const { hooksRaw, statuslineRaw } = await readRunnerObservabilityFiles(vars);
  const hooks = parseHookJsonl(hooksRaw);
  const statusline = parseStatuslineJson(statuslineRaw);
  return { hooks, statusline };
}

export const claudeHookObservability: RunnerObservability = {
  async getActivity(vars) {
    const { hooks, statusline } = await loadObservabilitySnapshot(vars);
    return deriveRunnerActivity(hooks, statusline);
  },

  async getContextPct(vars) {
    const { statusline } = await loadObservabilitySnapshot(vars);
    return contextPctFromStatusline(statusline);
  },

  async activeTool(vars) {
    const { hooks } = await loadObservabilitySnapshot(vars);
    return activeToolFromHooks(hooks);
  },

  async lastTurnCompletedAt(vars) {
    const { hooks } = await loadObservabilitySnapshot(vars);
    return lastTurnCompletedFromHooks(hooks);
  },
};