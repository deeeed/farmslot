import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';

export const RUNNER_ID = 'codex';
export const OBSERVABILITY_SCOPE = 'event-driven';

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
const DEFAULT_MODEL = 'gpt-5.6-sol';

export function binaryPath() {
  return CODEX_BIN;
}

export function prepareRepo(repo) {
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'runner-validate@farmslot.local'], {
    cwd: repo,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'runner-validate'], { cwd: repo, stdio: 'pipe' });
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), '[features]\nhooks = false\n');
}

export function assertBinary() {
  if (!fs.existsSync(CODEX_BIN)) {
    throw new Error(`codex binary missing: ${CODEX_BIN}`);
  }
}

export function buildLaunchCommand(
  repo,
  runtimeDir,
  prompt = DEFAULT_PROMPT,
  model = DEFAULT_MODEL,
) {
  assertBinary();
  const codexHome = path.join(repo, runtimeDir, 'codex-home');
  if (!fs.existsSync(codexHome)) {
    throw new Error(`codex-home missing after install: ${codexHome}`);
  }
  const modelFlag = model ? ['--model', shSingleQuote(model)] : [];
  return [
    `CODEX_HOME=${shSingleQuote(codexHome)}`,
    'node',
    shSingleQuote(CODEX_BIN),
    '--config',
    'features.hooks=true',
    'exec',
    '--sandbox',
    'workspace-write',
    ...modelFlag,
    shSingleQuote(prompt),
  ].join(' ');
}

/** Production-parity: open the interactive TUI; the gateway submits the prompt separately. */
export function buildInteractiveLaunchCommand(repo, runtimeDir = '.agent', model = DEFAULT_MODEL) {
  assertBinary();
  const codexHome = path.join(repo, runtimeDir, 'codex-home');
  if (!fs.existsSync(codexHome)) {
    throw new Error(`codex-home missing after install: ${codexHome}`);
  }
  return [
    `CODEX_HOME=${shSingleQuote(codexHome)}`,
    'node',
    shSingleQuote(CODEX_BIN),
    '--config',
    'features.hooks=true',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model',
    shSingleQuote(model),
  ].join(' ');
}

export function launchMode() {
  return 'codex-exec';
}

export function interactiveLaunchMode() {
  return 'codex-interactive';
}

export function supportsLiveScenario(scenario) {
  if (scenario === 'mode-switch' || scenario === 'busy-composer') return false;
  return true;
}

export function skipReason(scenario) {
  if (scenario === 'pane-smoke') return 'codex is event-driven; use hook-smoke';
  if (scenario === 'interaction-smoke') return 'codex exec path covered by hook-smoke';
  if (scenario === 'mode-switch') return 'codex exec mode has no interactive permission-mode TUI';
  if (scenario === 'busy-composer') return 'codex has no busy-composer TUI equivalent';
  return null;
}
