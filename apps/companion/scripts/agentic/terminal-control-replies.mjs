import { createHash } from 'node:crypto';

// Exact terminal capability/color answers observed from the checked-in xterm theme.
// No prefix, substring or general ANSI exemption may hide a worker instruction.
export const terminalControlReplies = Object.freeze([
  '\u001b[?1;2c',
  '\u001b[>0;276;0c',
  '\u001b]10;rgb:e0e0/e0e0/e8e8\u001b\\',
  '\u001b]11;rgb:0000/0000/0000\u001b\\',
]);
const hashes = new Set(
  terminalControlReplies.map((text) => createHash('sha256').update(text).digest('hex')),
);

export function workerInstructionAttempts(observed) {
  return observed.mutations.filter(
    (entry) => entry.method !== 'terminal.worker.input' || !hashes.has(entry.dataSha256),
  );
}
