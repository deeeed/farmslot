import { createHash } from 'node:crypto';

/** Normalize pane text the same way runner pane matchers do. */
export function normalizeInstructionText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/([/-])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function instructionNeedle(message: string): string {
  return normalizeInstructionText(message).slice(0, 160);
}

/** ADR-032: sha1(needle).slice(0, 16) — distinct from eval-template promptHash. */
export function runnerPromptDigest(message: string): string {
  return createHash('sha1').update(instructionNeedle(message)).digest('hex').slice(0, 16);
}