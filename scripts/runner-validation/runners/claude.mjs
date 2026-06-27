import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';

export const RUNNER_ID = 'claude';

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

export function prepareRepo() {
  // Claude hooks read project-scoped .claude/settings.local.json — no git required.
}

export function assertBinary() {
  if (!fs.existsSync(CLAUDE_BIN)) {
    throw new Error(`claude binary missing: ${CLAUDE_BIN}`);
  }
}

/** One-shot print mode — reliable in tmux shell panes (interactive compose does not submit). */
export function buildLaunchCommand(prompt = DEFAULT_PROMPT) {
  assertBinary();
  return `${shSingleQuote(CLAUDE_BIN)} --dangerously-skip-permissions -p ${shSingleQuote(prompt)}`;
}

export function launchMode() {
  return 'claude-print';
}

export function supportsLiveScenario() {
  return true;
}

export function skipReason() {
  return null;
}