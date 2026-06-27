import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const TMUX_SKILL = path.join(ROOT, '.agents/skills/tmux-model-driver/scripts');
export const EVIDENCE_DIR = path.join(ROOT, 'docs/operations/evidence');
export const PROMPT_MARKER = 'TMUX_HOOK_OK';
export const DEFAULT_PROMPT = `Reply with exactly ${PROMPT_MARKER} and nothing else.`;

export function hostSlug() {
  return os.hostname().replace(/\.local$/, '');
}

export function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function sleepMs(ms) {
  execFileSync('sleep', [String(Math.max(0.1, ms / 1000))]);
}