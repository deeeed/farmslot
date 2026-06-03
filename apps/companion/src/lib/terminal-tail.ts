const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CSI_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESCAPE_PATTERN = /\x1b[@-Z\\-_]/g;
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function appendTerminalTailText(
  currentText: string,
  chunk: string,
  maxChars = 20_000,
): string {
  if (!chunk) return currentText.slice(-maxChars);
  return `${currentText}${chunk}`.slice(-maxChars);
}

export function terminalTailLinesFromText(rawText: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const normalized = stripTerminalControls(rawText)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
  return normalized.slice(-maxLines);
}

export function stripTerminalControls(rawText: string): string {
  return rawText
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHARS_PATTERN, '');
}
export function trimTrailingTerminalBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(0, Math.max(1, end));
}
