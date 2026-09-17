import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';

export const RUNNER_ID = 'pi';
export const OBSERVABILITY_SCOPE = 'event-driven';
export const OBSERVABILITY_TRANSPORT = 'hooks';
export const REGISTERED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
];

const PI_CANDIDATES = [
  process.env.PI_PATH,
  path.join(os.homedir(), '.local/bin/pi'),
  path.join(os.homedir(), '.npm-global/bin/pi'),
  'pi',
].filter(Boolean);

function resolveBinary() {
  for (const candidate of PI_CANDIDATES) {
    if (candidate === 'pi') continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  } catch {
    return 'pi';
  }
}

export function prepareRepo(repo) {
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'runner-validate@farmslot.local'], {
    cwd: repo,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'runner-validate'], { cwd: repo, stdio: 'pipe' });
}

export function assertBinary() {
  try {
    execFileSync(resolveBinary(), ['--version'], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`pi binary unavailable: ${error?.message || String(error)}`);
  }
}

function extensionPath(repo, runtimeDir) {
  return path.join(repo, runtimeDir, '.observability', 'pi-farmslot-observability.ts');
}

function obsDir(repo, runtimeDir) {
  return path.join(repo, runtimeDir, '.observability');
}

/** Print mode — fires the same extension hooks as the TUI without a composer. */
export function buildLaunchCommand(
  repo,
  runtimeDir,
  prompt = DEFAULT_PROMPT,
  model = 'xai/grok-4.6',
) {
  assertBinary();
  const bin = resolveBinary();
  const ext = extensionPath(repo, runtimeDir);
  const dir = obsDir(repo, runtimeDir);
  return [
    `FARMSLOT_OBS_DIR=${shSingleQuote(dir)}`,
    'FARMSLOT_RUNNER=pi',
    shSingleQuote(bin),
    '--approve',
    '--no-session',
    `-e ${shSingleQuote(ext)}`,
    `--model ${shSingleQuote(model)}`,
    `-p ${shSingleQuote(prompt)}`,
  ].join(' ');
}

export function launchMode() {
  return 'pi-print';
}

/** Production-parity TUI. Prompt is delivered after SessionStart, not via -p. */
export function buildInteractiveLaunchCommand(repo, runtimeDir, model = 'xai/grok-4.6') {
  assertBinary();
  const bin = resolveBinary();
  const ext = extensionPath(repo, runtimeDir);
  const dir = obsDir(repo, runtimeDir);
  return [
    `FARMSLOT_OBS_DIR=${shSingleQuote(dir)}`,
    'FARMSLOT_RUNNER=pi',
    shSingleQuote(bin),
    '--approve',
    `-e ${shSingleQuote(ext)}`,
    `--model ${shSingleQuote(model)}`,
  ].join(' ');
}

export function interactiveLaunchMode() {
  return 'pi-interactive';
}

export function skipReason(scenario) {
  if (scenario === 'pane-smoke' || scenario === 'busy-composer' || scenario === 'mode-switch') {
    return 'pi is event-driven; use hook-smoke and prompt-accepted';
  }
  if (scenario === 'interaction-smoke') {
    return 'pi uses pi-interactive-prompt';
  }
  return null;
}
