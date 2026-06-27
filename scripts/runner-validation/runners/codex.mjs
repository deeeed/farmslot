import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';

export const RUNNER_ID = 'codex';

export const REGISTERED_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
];

const CODEX_BIN = path.join(
  os.homedir(),
  '.npm-global/lib/node_modules/@openai/codex/bin/codex.js',
);

export function prepareRepo(repo) {
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'runner-validate@farmslot.local'], {
    cwd: repo,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'runner-validate'], { cwd: repo, stdio: 'pipe' });
}

export function assertBinary() {
  if (!fs.existsSync(CODEX_BIN)) {
    throw new Error(`codex binary missing: ${CODEX_BIN}`);
  }
}

export function buildLaunchCommand(repo, runtimeDir, prompt = DEFAULT_PROMPT) {
  assertBinary();
  const codexHome = path.join(repo, runtimeDir, 'codex-home');
  if (!fs.existsSync(codexHome)) {
    throw new Error(`codex-home missing after install: ${codexHome}`);
  }
  return [
    `CODEX_HOME=${shSingleQuote(codexHome)}`,
    'node',
    shSingleQuote(CODEX_BIN),
    'exec',
    '--disable',
    'plugin_hooks',
    '--sandbox',
    'workspace-write',
    shSingleQuote(prompt),
  ].join(' ');
}

export function launchMode() {
  return 'codex-exec';
}

export function supportsLiveScenario(scenario) {
  if (scenario === 'mode-switch' || scenario === 'busy-composer') return false;
  return true;
}

export function skipReason(scenario) {
  if (scenario === 'mode-switch') return 'codex exec mode has no interactive permission-mode TUI';
  if (scenario === 'busy-composer') return 'codex has no busy-composer TUI equivalent';
  return null;
}