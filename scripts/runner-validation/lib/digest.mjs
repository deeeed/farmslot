import { createHash } from 'node:crypto';

// Keep in sync with services/gateway/src/runners/observability-prompt-digest.ts
export function normalizeInstructionText(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/([/-])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function instructionNeedle(message) {
  return normalizeInstructionText(message).slice(0, 160);
}

export function runnerPromptDigest(message) {
  return createHash('sha1').update(instructionNeedle(message)).digest('hex').slice(0, 16);
}