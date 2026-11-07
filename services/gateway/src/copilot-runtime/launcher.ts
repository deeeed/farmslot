import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { COPILOT_TMUX_SESSION } from '@farmslot/protocol';

import { farmslotRoot } from '../projects/repo-root.js';
import {
  DEFAULT_COPILOT_RUNNER,
  getRunnerDefinition,
  isKnownRunner,
  normalizeRunner,
  runnerDefaultModel,
  runnerSupportsEffort,
} from '../runners/registry.js';

const execFileAsync = promisify(execFile);
export { COPILOT_TMUX_SESSION };
export interface CopilotTmuxAdapter {
  listCandidates(session: string): Promise<string[]>;
  kill(session: string): Promise<void>;
}
/** Migration guard only. Existing TUI work stays accessible through explicit Terminal. */
export const localCopilotTmuxAdapter: CopilotTmuxAdapter = {
  async listCandidates(session) {
    try {
      const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
      return stdout
        .split('\n')
        .filter((candidate) => candidate === session || candidate.startsWith(`${session}-`))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return [];
      throw error;
    }
  },
  async kill(session) {
    if ((await this.listCandidates(session)).includes(session))
      await execFileAsync('tmux', ['kill-session', '-t', `=${session}`]);
  },
};
export function resolveOperatorCheckout(): string {
  return path.resolve(process.env.FARMSLOT_OPERATOR_CHECKOUT?.trim() || farmslotRoot);
}

export function resolveCopilotRunner(input?: {
  runner?: string;
  model?: string;
  effort?: string;
}): {
  runner: string;
  model: string;
  effort: string;
} {
  const runner = normalizeRunner(
    input?.runner || process.env.FARMSLOT_COPILOT_RUNNER || DEFAULT_COPILOT_RUNNER,
  );
  if (!isKnownRunner(runner) || !getRunnerDefinition(runner).nativeTransport) {
    throw new Error(`Runner '${runner}' does not support the native Co-Pilot runtime`);
  }
  const model =
    input?.model || process.env.FARMSLOT_COPILOT_MODEL || runnerDefaultModel(runner) || 'unknown';
  if (!getRunnerDefinition(runner).acceptsModel(model)) {
    throw new Error(`Runner '${runner}' does not accept model '${model}'`);
  }
  const effort =
    input?.effort ??
    process.env.FARMSLOT_COPILOT_EFFORT ??
    (runnerSupportsEffort(runner, model, 'low') ? 'low' : 'auto');
  if (!runnerSupportsEffort(runner, model, effort))
    throw new Error(`Runner '${runner}' does not accept effort '${effort}' for '${model}'`);
  return { runner, model, effort };
}
