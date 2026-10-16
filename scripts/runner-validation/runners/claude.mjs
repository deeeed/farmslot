import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runnerRuntimeDir } from '../../lib/runner-runtime.cjs';
import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';

export const RUNNER_ID = 'claude';
export const OBSERVABILITY_SCOPE = 'event-driven';
export const OBSERVABILITY_TRANSPORT = 'hooks';

export const REGISTERED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
];

const CLAUDE_BIN = path.join(os.homedir(), '.npm-global/bin/claude');

export function binaryPath() {
  return CLAUDE_BIN;
}

export function prepareRepo() {
  // Farmslot passes its runtime-owned hook settings explicitly at launch.
}

export function assertBinary() {
  if (!fs.existsSync(CLAUDE_BIN)) {
    throw new Error(`claude binary missing: ${CLAUDE_BIN}`);
  }
}

function launchCommand(repo, runtimeDir, model) {
  assertBinary();
  const modelFlag = model ? ` --model ${shSingleQuote(model)}` : '';
  const settingsPath = path.join(
    runnerRuntimeDir(repo, runtimeDir),
    '.observability',
    'claude-settings.json',
  );
  return `${shSingleQuote(CLAUDE_BIN)} --dangerously-skip-permissions${modelFlag} --settings ${shSingleQuote(settingsPath)}`;
}

/** One-shot print mode — reliable in tmux shell panes (interactive compose does not submit). */
export function buildLaunchCommand(repo, runtimeDir, prompt = DEFAULT_PROMPT, model = 'opus') {
  return `${launchCommand(repo, runtimeDir, model)} -p ${shSingleQuote(prompt)}`;
}

export function launchMode() {
  return 'claude-print';
}

export function supportsLiveScenario() {
  return true;
}

export function skipReason(scenario) {
  if (scenario === 'pane-smoke') {
    return 'claude is event-driven; use hook-smoke';
  }
  if (scenario === 'interaction-smoke') {
    return 'claude print path covered by hook-smoke';
  }
  return null;
}

/** Retain the interactive runner while its native background job finishes. */
export function buildInteractiveLaunchCommand(repo, runtimeDir, prompt, model = 'opus') {
  return `${launchCommand(repo, runtimeDir, model)} ${shSingleQuote(prompt)}`;
}
