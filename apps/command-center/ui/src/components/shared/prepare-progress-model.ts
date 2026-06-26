export interface PrepareProgressStep {
  name: string;
  detail: string;
  at: number;
}

export interface PrepareProgressState {
  slotId: string;
  requestId: string;
  running: boolean;
  steps: PrepareProgressStep[];
  lines: string[];
  exitCode: number | null;
  error: string;
  label: string;
}

const MAX_LINES = 500;

export function createPrepareProgressState(args: {
  slotId: string;
  requestId: string;
  label?: string;
}): PrepareProgressState {
  return {
    slotId: args.slotId,
    requestId: args.requestId,
    running: true,
    steps: [],
    lines: [],
    exitCode: null,
    error: '',
    label: args.label ?? 'Preparing slot',
  };
}

/** Split streamed prepare output without dropping intentional blank lines. */
export function splitPrepareOutputLines(data: string): string[] {
  if (!data) return [];
  const chunks = data.split('\n');
  if (chunks.length > 0 && chunks[chunks.length - 1] === '') {
    return chunks.slice(0, -1);
  }
  return chunks;
}

export function appendPrepareOutput(
  state: PrepareProgressState,
  data: string,
): PrepareProgressState {
  const chunks = splitPrepareOutputLines(data);
  if (chunks.length === 0) return state;
  const lines = [...state.lines, ...chunks];
  return {
    ...state,
    lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines,
  };
}

export function recordPrepareStep(
  state: PrepareProgressState,
  name: string,
  detail: string,
): PrepareProgressState {
  return {
    ...state,
    steps: [...state.steps, { name, detail, at: Date.now() }],
  };
}

export function parsePrepareOutputLine(line: string): { name: string; detail: string } | null {
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line.trim());
  if (!match) return null;
  return { name: match[1]!, detail: match[2] ?? '' };
}

export function ingestPrepareOutputLine(
  state: PrepareProgressState,
  line: string,
): PrepareProgressState {
  const next = appendPrepareOutput(state, line);
  const parsed = parsePrepareOutputLine(line);
  if (!parsed) return next;
  return recordPrepareStep(next, parsed.name, parsed.detail);
}
