import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  COPILOT_TMUX_SESSION,
  COPILOT_TMUX_TARGET,
  COPILOT_TMUX_WINDOW_NAME,
  type SafetyTier,
} from '@farmslot/protocol';
import type { SlotVars } from '@farmslot/slot-config';

import { shellQuote } from '../core/tmux.js';
import { farmslotRoot } from '../projects/repo-root.js';
import { buildLaunchCommand } from '../runners/launch-command.js';
import {
  DEFAULT_COPILOT_RUNNER,
  getRunnerDefinition,
  isKnownRunner,
  normalizeRunner,
  runnerDefaultModel,
} from '../runners/registry.js';

import type { CopilotRuntimeStore } from './session-store.js';

const execFileAsync = promisify(execFile);
export { COPILOT_TMUX_SESSION, COPILOT_TMUX_TARGET };

export interface CopilotTmuxAdapter {
  listCandidates(session: string): Promise<string[]>;
  launch(session: string, checkout: string, command: string): Promise<{ paneId?: string }>;
  configureTranscript(target: string, transcriptPath: string): Promise<void>;
  kill(session: string): Promise<void>;
}

export const localCopilotTmuxAdapter: CopilotTmuxAdapter = {
  async listCandidates(session) {
    try {
      const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
      return stdout
        .split('\n')
        .filter(Boolean)
        .filter((candidate) => candidate === session || candidate.startsWith(`${session}-`))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return [];
      throw error;
    }
  },
  async launch(session, checkout, command) {
    await execFileAsync('tmux', [
      'new-session',
      '-d',
      '-s',
      session,
      '-n',
      COPILOT_TMUX_WINDOW_NAME,
      '-c',
      checkout,
      command,
    ]);
    await execFileAsync('tmux', [
      'set-window-option',
      '-t',
      `${session}:${COPILOT_TMUX_WINDOW_NAME}`,
      'pane-base-index',
      '0',
    ]);
    const { stdout: windowIndex } = await execFileAsync('tmux', [
      'list-windows',
      '-t',
      `=${session}`,
      '-F',
      '#{window_index}',
    ]);
    if (windowIndex.trim() !== '0') {
      await execFileAsync('tmux', [
        'move-window',
        '-s',
        `${session}:${COPILOT_TMUX_WINDOW_NAME}`,
        '-t',
        `${session}:0`,
      ]);
    }
    await execFileAsync('tmux', ['set-option', '-t', session, 'base-index', '0']);
    const { stdout } = await execFileAsync('tmux', [
      'list-panes',
      '-t',
      `=${session}`,
      '-F',
      '#{pane_id}',
    ]);
    return { paneId: stdout.split('\n').find(Boolean) };
  },
  async configureTranscript(target, transcriptPath) {
    await execFileAsync('tmux', [
      'pipe-pane',
      '-O',
      '-t',
      target,
      `cat >> ${shellQuote(transcriptPath)}`,
    ]);
  },
  async kill(session) {
    const candidates = await this.listCandidates(session);
    if (!candidates.includes(session)) return;
    await execFileAsync('tmux', ['kill-session', '-t', `=${session}`]);
  },
};

export function resolveOperatorCheckout(): string {
  return path.resolve(process.env.FARMSLOT_OPERATOR_CHECKOUT?.trim() || farmslotRoot);
}

export function createCopilotRunnerVars(checkout: string): SlotVars {
  const host = os.hostname().replace(/\.local$/, '');
  return {
    slotId: 'gateway-copilot',
    machine: host,
    platform: process.platform,
    host: 'localhost',
    sshUser: '',
    osType: process.platform,
    claudePath: process.env.CLAUDE_PATH?.trim() || '',
    codexPath: process.env.CODEX_PATH?.trim() || '',
    opencodePath: process.env.OPENCODE_PATH?.trim() || '',
    cursorPath: process.env.CURSOR_PATH?.trim() || '',
    grokPath: process.env.GROK_PATH?.trim() || '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: checkout,
    session: COPILOT_TMUX_SESSION,
    slotMode: 'custom',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo: checkout,
    projectName: 'farmslot-farm',
    resourceVars: {},
  };
}

export function resolveCopilotRunner(input?: { runner?: string; model?: string }): {
  runner: string;
  model: string;
} {
  const runner = normalizeRunner(
    input?.runner || process.env.FARMSLOT_COPILOT_RUNNER || DEFAULT_COPILOT_RUNNER,
  );
  if (!isKnownRunner(runner) || !getRunnerDefinition(runner).supportsInteractivePrompt) {
    throw new Error(`Runner '${runner}' does not support the interactive Co-Pilot runtime`);
  }
  const model =
    input?.model || process.env.FARMSLOT_COPILOT_MODEL || runnerDefaultModel(runner) || 'unknown';
  if (!getRunnerDefinition(runner).acceptsModel(model)) {
    throw new Error(`Runner '${runner}' does not accept model '${model}'`);
  }
  return { runner, model };
}

export function buildCopilotLaunch(input: {
  checkout: string;
  runner: string;
  model: string;
  safetyTier: SafetyTier;
  bootstrapPrompt: string;
  store: CopilotRuntimeStore;
  runtimeDir?: string;
}): { command: string; commandHash: string; vars: SlotVars } {
  const vars = createCopilotRunnerVars(input.checkout);
  const runtimeDir = input.runtimeDir ?? '.agent';
  const command = buildLaunchCommand(vars, input.runner, input.model, input.bootstrapPrompt, {
    repo: input.checkout,
    safetyTier: input.safetyTier,
    runtimeDir,
  });
  if (!command.trim()) throw new Error(`Runner '${input.runner}' produced no launch command`);
  return {
    command,
    commandHash: createHash('sha256').update(command).digest('hex'),
    vars,
  };
}
