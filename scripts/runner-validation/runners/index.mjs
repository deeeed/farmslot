import * as claude from './claude.mjs';
import * as codex from './codex.mjs';

const RUNNERS = {
  claude,
  codex,
};

export function getRunnerAdapter(runnerId) {
  const adapter = RUNNERS[runnerId];
  if (!adapter) throw new Error(`unsupported runner: ${runnerId}`);
  return adapter;
}

export function listRunners() {
  return Object.keys(RUNNERS);
}