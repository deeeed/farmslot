import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';

export const RUNNER_ID = 'grok';
export const OBSERVABILITY_SCOPE = 'pane-only';
export const REGISTERED_EVENTS = [];

const GROK_BIN = path.join(os.homedir(), '.grok/bin/grok');
const DEFAULT_MODEL = 'grok-4.5';

export function prepareRepo(repo) {
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'runner-validate@farmslot.local'], {
    cwd: repo,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'runner-validate'], { cwd: repo, stdio: 'pipe' });
}

function resolveBinary() {
  if (fs.existsSync(GROK_BIN)) return GROK_BIN;
  return 'grok';
}

export function assertBinary() {
  try {
    execFileSync(resolveBinary(), ['--version'], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`grok binary unavailable: ${error?.message || String(error)}`);
  }
}

/** Headless single-turn — reliable for tmux shell smoke. */
export function buildLaunchCommand(prompt = DEFAULT_PROMPT, model = DEFAULT_MODEL) {
  assertBinary();
  const bin = resolveBinary();
  return `${shSingleQuote(bin)} -p ${shSingleQuote(prompt)} --model ${model}`;
}

/** Production-parity: open interactive TUI; prompt delivered separately. */
export function buildInteractiveLaunchCommand() {
  assertBinary();
  const bin = resolveBinary();
  return `${shSingleQuote(bin)} --model ${DEFAULT_MODEL}`;
}

export function launchMode() {
  return 'grok-print';
}

export function interactiveLaunchMode() {
  return 'grok-interactive';
}

export function skipReason(scenario) {
  if (scenario === 'hook-smoke' || scenario === 'prompt-accepted' || scenario === 'turn-boundary') {
    return 'grok is pane-only (observabilityScope); use pane-smoke or interaction-smoke';
  }
  if (scenario === 'busy-composer') {
    return 'grok busy-composer pane fixtures not curated yet';
  }
  if (scenario === 'mode-switch') {
    return 'grok mode-switch covered by interaction-smoke launch flags when needed';
  }
  return null;
}
