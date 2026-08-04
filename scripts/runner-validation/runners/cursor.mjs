import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROMPT, shSingleQuote } from '../lib/common.mjs';

export const RUNNER_ID = 'cursor';
export const OBSERVABILITY_SCOPE = 'pane-only';
export const REGISTERED_EVENTS = [];

const CURSOR_BIN = path.join(os.homedir(), '.local/bin/cursor-agent');
const DEFAULT_MODEL = 'composer-2.5';

function resolveBinary() {
  if (fs.existsSync(CURSOR_BIN)) return CURSOR_BIN;
  return 'cursor-agent';
}

export function assertBinary() {
  try {
    execFileSync(resolveBinary(), ['--version'], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`cursor-agent binary unavailable: ${error?.message || String(error)}`);
  }
}

export function prepareRepo() {
  // Cursor launches from repo cwd; no git requirement today.
}

/** Print mode — matches gateway steerability without post-launch send-keys. */
export function buildLaunchCommand(_repo, _runtimeDir, prompt = DEFAULT_PROMPT, _model) {
  assertBinary();
  const bin = resolveBinary();
  return `${shSingleQuote(bin)} --print --trust --sandbox enabled --model ${DEFAULT_MODEL} ${shSingleQuote(prompt)}`;
}

/** Argv prompt launch (gateway inline path). */
export function buildArgvLaunchCommand(prompt = DEFAULT_PROMPT) {
  assertBinary();
  const bin = resolveBinary();
  return `${shSingleQuote(bin)} --sandbox enabled --model ${DEFAULT_MODEL} ${shSingleQuote(prompt)}`;
}

export function launchMode() {
  return 'cursor-print';
}

export function skipReason(scenario) {
  if (scenario === 'hook-smoke' || scenario === 'prompt-accepted' || scenario === 'turn-boundary') {
    return 'cursor is pane-only (observabilityScope); use pane-smoke';
  }
  if (scenario === 'session-attribution-smoke') {
    return 'cursor persistsSessionFiles=false; session attribution unavailable';
  }
  if (scenario === 'token-usage-smoke') {
    return 'cursor interactive TUI has no durable token transcript; headless partial only';
  }
  if (scenario === 'busy-composer') {
    return 'cursor busy-composer pane fixtures not curated yet';
  }
  if (scenario === 'mode-switch') {
    return 'cursor trust/mode covered via --trust in pane-smoke print launch';
  }
  if (scenario === 'interaction-smoke') {
    return 'cursor argv launch is single-phase; pane-smoke covers it';
  }
  return null;
}
