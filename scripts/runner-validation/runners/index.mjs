import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as cursor from './cursor.mjs';
import * as grok from './grok.mjs';

const RUNNERS = {
  claude,
  codex,
  cursor,
  grok,
};

/** Preset groups for orchestrator --runner */
export const RUNNER_GROUPS = {
  both: ['claude', 'codex'],
  hooks: ['claude', 'codex'],
  'pane-only': ['cursor', 'grok'],
  all: ['claude', 'codex', 'cursor', 'grok'],
};

export function getRunnerAdapter(runnerId) {
  const adapter = RUNNERS[runnerId];
  if (!adapter) throw new Error(`unsupported runner: ${runnerId}`);
  return adapter;
}

export function listRunners() {
  return Object.keys(RUNNERS);
}

export function resolveRunnerList(runnerArg) {
  if (runnerArg in RUNNER_GROUPS) return RUNNER_GROUPS[runnerArg];
  if (!listRunners().includes(runnerArg)) {
    throw new Error(`unsupported runner: ${runnerArg} (try ${Object.keys(RUNNER_GROUPS).join(', ')})`);
  }
  return [runnerArg];
}