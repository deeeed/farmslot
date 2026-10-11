import { instructionNeedle, normalizeInstructionText } from './observability-prompt-digest.js';

export function runnerPaneContainsInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  return normalizeInstructionText(pane).includes(needle);
}

export function runnerPaneHasQueuedInstruction(
  pane: string,
  message?: string,
  submittedExact = false,
): boolean {
  const lines = pane.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n');
  const marker = lines
    .map((_, index) =>
      /^[•│┃║\s]*(?:messages? to be submitted after next tool call|(?:\d+\s+)?queued messages?|message queued)(?=[:\s]|$)/i.test(
        normalizeInstructionText(lines.slice(index).join(' ')),
      ),
    )
    .lastIndexOf(true);
  if (message === undefined)
    return (
      marker !== -1 &&
      /submitted after next tool call/i.test(
        normalizeInstructionText(lines.slice(marker).join(' ')),
      )
    );
  if (submittedExact) {
    if (marker === -1) return false;
    const body = lines.slice(marker + 1);
    const composer = body.map((line) => /^\s*[›❯](?:\s|$)/.test(line)).lastIndexOf(true);
    const firstMessage = body.findIndex((line) => /^\s*[↳›❯](?:\s|$)/.test(line));
    if (composer === -1 || firstMessage === -1 || firstMessage >= composer) return false;
    const queued = body
      .slice(firstMessage, composer)
      .map((line) => line.replace(/^\s*[↳›❯]\s?/, ''))
      .join('\n');
    return normalizeInstructionText(queued) === normalizeInstructionText(message);
  }
  if (!runnerPaneContainsInstruction(pane, message)) return false;
  const compactPane = normalizeInstructionText(pane).toLowerCase();
  return (
    compactPane.includes('messages to be submitted after next tool call') ||
    compactPane.includes('submitted after next tool call') ||
    compactPane.includes('message queued') ||
    compactPane.includes('queued message') ||
    compactPane.includes('tab to queue message')
  );
}
