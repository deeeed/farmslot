import { instructionNeedle, normalizeInstructionText } from './observability-prompt-digest.js';

export function runnerPaneContainsInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  return normalizeInstructionText(pane).includes(needle);
}

export function runnerPaneBufferedInstruction(pane: string): string {
  const lines = pane
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .trimEnd()
    .split('\n');
  // Claude draws its live composer between the last two rules; plugin status lines below vary.
  // Locate it by the rules, since a draft line can itself start with the prompt marker.
  // Bash mode keeps its `!` marker, so it never reads as an empty composer.
  const rule = (line: string) => /^\s*─{8,}\s*$/.test(line);
  const boxEnd = lines.map(rule).lastIndexOf(true);
  const boxStart = lines
    .map(
      (line, index) =>
        index < boxEnd - 1 && rule(line) && /^\s*[❯!](?:\s|$)/.test(lines[index + 1]),
    )
    .lastIndexOf(true);
  if (boxStart !== -1) {
    const text = normalizeInstructionText(
      lines
        .slice(boxStart + 1, boxEnd)
        .join('\n')
        .replace(/^\s*❯\s?/, ''),
    );
    return text === 'Press up to edit queued messages' ? '' : text;
  }
  const footer = lines
    .map((line) =>
      /\? for shortcuts|\bcontext(?:\s+\d+%)?\s+left\b|\btab to queue message\b|← for agents|⚠\s+\d+\s+warnings?\b/i.test(
        line,
      ),
    )
    .lastIndexOf(true);
  const content = footer === -1 ? lines : lines.slice(0, footer);
  const composer = content.map((line) => /^\s*[›❯](?:\s|$)/.test(line)).lastIndexOf(true);
  if (composer === -1 || (footer === -1 && composer !== lines.length - 1)) return '';
  const body = content.slice(composer);
  // Only the bottom composer above the status footer is live input. Transcript prompts are history.
  const separator = body.map((line) => !line.trim()).lastIndexOf(true);
  const buffered = (separator === -1 ? body : body.slice(0, separator))
    .map((line, index) => (index === 0 ? line.replace(/^\s*[›❯]\s?/, '') : line))
    .join('\n');
  const text = normalizeInstructionText(buffered);
  return text === 'Ask Codex to do anything' ? '' : text;
}

export function runnerPaneHasBufferedInstruction(pane: string, message: string): boolean {
  const buffered = runnerPaneBufferedInstruction(pane);
  return Boolean(buffered) && buffered === normalizeInstructionText(message);
}

export function runnerPaneHasQueuedInstruction(
  pane: string,
  message?: string,
  submittedExact = false,
  allowTruncatedPreview = false,
): boolean {
  const lines = pane.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n');
  const marker = lines
    .map((_, index) =>
      /^[•│┃║\s]*(?:messages? to be submitted after next tool call|queued follow-up inputs?|(?:\d+\s+)?queued messages?|message queued)(?=[:\s]|$)/i.test(
        normalizeInstructionText(lines.slice(index).join(' ')),
      ),
    )
    .lastIndexOf(true);
  if (message === undefined)
    return (
      marker !== -1 &&
      /submitted after next tool call|queued follow-up inputs?/i.test(
        normalizeInstructionText(lines.slice(marker).join(' ')),
      )
    );
  if (submittedExact) {
    // Only the Enter steering block proves delivery. Follow-up input waits for the turn to end.
    if (
      marker === -1 ||
      !/^[•│┃║\s]*messages? to be submitted after next tool call/i.test(
        normalizeInstructionText(lines.slice(marker).join(' ')),
      )
    )
      return false;
    const body = lines.slice(marker + 1);
    const composer = body.map((line) => /^\s*[›❯](?:\s|$)/.test(line)).lastIndexOf(true);
    const firstMessage = body.findIndex((line) => /^\s*[↳›❯](?:\s|$)/.test(line));
    if (composer === -1 || firstMessage === -1 || firstMessage >= composer) return false;
    const editHint = body.findIndex((line) => /^\s*⇧←\s+edit last queued message\b/i.test(line));
    const end = editHint !== -1 ? Math.min(editHint, composer) : composer;
    const queuedLines = body
      .slice(firstMessage, end)
      .map((line) => line.replace(/^\s*[↳›❯]\s?/, ''))
      .filter((line) => line.trim());
    const expected = normalizeInstructionText(message);
    if (normalizeInstructionText(queuedLines.join('\n')) === expected) return true;
    const preview = normalizeInstructionText(queuedLines.slice(0, -1).join('\n'));
    // The native preview caps long messages and renders a separate overflow line.
    // Only a fresh owned submit from an empty queue may use that preview as delivery proof.
    return (
      allowTruncatedPreview &&
      queuedLines.at(-1)?.trim() === '…' &&
      body.slice(firstMessage, end).filter((line) => /^\s*↳\s/.test(line)).length === 1 &&
      Boolean(preview) &&
      expected.startsWith(preview)
    );
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
