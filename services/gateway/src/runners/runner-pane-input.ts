import { instructionNeedle, normalizeInstructionText } from './observability-prompt-digest.js';

const ANSI_SEQUENCE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function runnerPaneContainsInstruction(pane: string, message: string): boolean {
  const needle = instructionNeedle(message);
  if (!needle) return false;
  return normalizeInstructionText(pane).includes(needle);
}

interface LiveComposer {
  lines: string[];
  start: number;
  end: number;
  text: string;
  suggestion?: boolean;
}

/** Only an entirely dim body after the prompt is a suggestion; typed text keeps its veto. */
function withoutDimSuggestion(lines: string[]): string[] | null {
  let dim = false;
  let ordinary = '';
  let suggestion = '';
  for (const part of lines.join('\n').split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[') && part.endsWith('m')) {
      const codes = part.slice(2, -1).split(';').map(Number);
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index];
        if (code === 38 || code === 48 || code === 58) {
          // Extended color's 2 is an RGB selector, not the dim attribute.
          index += codes[index + 1] === 2 ? 4 : codes[index + 1] === 5 ? 2 : 0;
        } else if (code === 0 || code === 22) dim = false;
        else if (code === 2) dim = true;
      }
    } else if (dim) {
      suggestion += part;
      ordinary += part.replace(/[^\n]/g, '');
    } else ordinary += part;
  }
  if (!normalizeInstructionText(suggestion) || normalizeInstructionText(ordinary) !== '❯')
    return null;
  return ordinary.replace(ANSI_SEQUENCE, '').split('\n');
}

// The live composer: the line span holding unsent input and its normalized text.
function liveComposer(pane: string): LiveComposer | null {
  const rawLines = pane.trimEnd().split('\n');
  const lines = rawLines.map((line) => line.replace(ANSI_SEQUENCE, ''));
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
    const suggestion = withoutDimSuggestion(rawLines.slice(boxStart + 1, boxEnd));
    if (suggestion) lines.splice(boxStart + 1, boxEnd - boxStart - 1, ...suggestion);
    const text = normalizeInstructionText(
      lines
        .slice(boxStart + 1, boxEnd)
        .join('\n')
        .replace(/^\s*❯\s?/, ''),
    );
    return {
      lines,
      start: boxStart + 1,
      end: boxEnd,
      text: text === 'Press up to edit queued messages' ? '' : text,
      suggestion: Boolean(suggestion),
    };
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
  if (composer === -1 || (footer === -1 && composer !== lines.length - 1)) return null;
  const body = content.slice(composer);
  // Only the bottom composer above the status footer is live input. Transcript prompts are history.
  const separator = body.map((line) => !line.trim()).lastIndexOf(true);
  const end = composer + (separator === -1 ? body.length : separator);
  const buffered = lines
    .slice(composer, end)
    .map((line, index) => (index === 0 ? line.replace(/^\s*[›❯]\s?/, '') : line))
    .join('\n');
  const text = normalizeInstructionText(buffered);
  return { lines, start: composer, end, text: text === 'Ask Codex to do anything' ? '' : text };
}

export function runnerPaneBufferedInstruction(pane: string): string {
  return liveComposer(pane)?.text ?? '';
}

/** Keep pane safety checks plain while removing only a boxed prompt suggestion. */
export function runnerPaneWithoutPromptSuggestion(pane: string): string {
  const composer = liveComposer(pane);
  return composer?.suggestion ? composer.lines.join('\n') : pane.replace(ANSI_SEQUENCE, '');
}

/** The pane without its live composer lines, so unsent input never reads as runner output. */
export function runnerPaneWithoutComposer(pane: string): string {
  const composer = liveComposer(pane);
  return composer
    ? [...composer.lines.slice(0, composer.start), ...composer.lines.slice(composer.end)].join('\n')
    : pane;
}

export function runnerPaneHasBufferedInstruction(pane: string, message: string): boolean {
  const buffered = runnerPaneBufferedInstruction(pane);
  return Boolean(buffered) && buffered === normalizeInstructionText(message);
}

export function runnerPaneHasQueuedInstruction(
  pane: string,
  message?: string,
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
  // Only the complete Enter steering block proves delivery. Follow-up input waits for the turn
  // to end, and hints such as "tab to queue message" mean the text was never submitted.
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
