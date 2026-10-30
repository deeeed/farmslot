// The body stops at the first ESC: a hyperlink (OSC 8) ends at its own terminator, so its text stays.
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESCAPE_PATTERN = /\x1b[@-Z\\-_]/g;
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Terminal output as plain text: escape sequences and control characters removed. */
export function stripTerminalControls(rawText: string): string {
  return rawText
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHARS_PATTERN, '');
}

/** The lines a terminal shows: controls stripped, a carriage return starts a line, no final empty line. */
export function terminalLinesFromText(rawText: string): string[] {
  return stripTerminalControls(rawText)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

export function terminalTailLinesFromText(rawText: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  return terminalLinesFromText(rawText).slice(-maxLines);
}
