import { terminalTailLinesFromText } from '@farmslot/protocol/client-cache';

export { stripTerminalControls, terminalTailLinesFromText } from '@farmslot/protocol/client-cache';

export function appendTerminalTailText(
  currentText: string,
  chunk: string,
  maxChars = 20_000,
): string {
  if (!chunk) return currentText.slice(-maxChars);
  return `${currentText}${chunk}`.slice(-maxChars);
}

export function terminalHistoryTextFromText(rawText: string, maxLines: number): string {
  return terminalTailLinesFromText(rawText, maxLines).join('\n');
}

export function trimTrailingTerminalBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(0, Math.max(1, end));
}
