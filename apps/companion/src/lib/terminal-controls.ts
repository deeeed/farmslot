import {
  type Run,
  type RunnerMobileKeyProfile,
  runnerMobileKeyProfile,
  type SlotStatus,
  type TmuxWindow,
  type TmuxWorkerRef,
  type TmuxWorkerSummary,
  tmuxWorkerWatchId,
} from '@farmslot/protocol';

export interface TerminalControlKey {
  label: string;
  data: string;
  danger: boolean;
}

export const TERMINAL_CONTROL_KEYS: readonly TerminalControlKey[] = [
  { label: '↑', data: '\x1b[A', danger: false },
  { label: '↓', data: '\x1b[B', danger: false },
  { label: '←', data: '\x1b[D', danger: false },
  { label: '→', data: '\x1b[C', danger: false },
  { label: 'Enter', data: '\r', danger: false },
  { label: 'Tab', data: '\x09', danger: false },
  { label: '⇧Tab', data: '\x1b[Z', danger: false },
  { label: 'Esc', data: '\x1b', danger: false },
  { label: '^C', data: '\x03', danger: true },
  { label: '^D', data: '\x04', danger: true },
  { label: '^U', data: '\x15', danger: false },
  { label: '^L', data: '\x0c', danger: false },
] as const;

/** What a terminal screen knows about the runner in the pane it drives. */
export interface TerminalRunnerContext {
  /** `tmuxWorkerWatchId` of the pane; keys the saved override. Null until the pane is known. */
  paneKey: string | null;
  /** `metrics.runner` of the run linked to the pane. */
  linkedRunner?: string | null;
  /** Gateway-derived `processRunnerIds` of the pane. */
  processRunnerIds?: readonly string[];
}

export type RunnerKeyProfileSource = 'saved' | 'run' | 'process' | 'generic';

export interface ResolvedRunnerKeyProfile {
  runnerId: string | null;
  source: RunnerKeyProfileSource;
  profile: RunnerMobileKeyProfile | null;
}

/** Saved pane override, keyed by `tmuxWorkerWatchId`, valued by runner id. */
export type RunnerKeyOverrides = Readonly<Record<string, string>>;

function resolvedFrom(runnerId: string, source: RunnerKeyProfileSource): ResolvedRunnerKeyProfile {
  return { runnerId, source, profile: runnerMobileKeyProfile(runnerId) };
}

/**
 * Saved pane override, then the linked run's runner, then one unambiguous
 * process match, then the generic row. Never reads pane text.
 */
export function resolveRunnerKeyProfile(
  context: TerminalRunnerContext,
  overrides: RunnerKeyOverrides,
): ResolvedRunnerKeyProfile {
  const saved = context.paneKey ? overrides[context.paneKey] : undefined;
  if (saved) return resolvedFrom(saved, 'saved');
  if (context.linkedRunner) return resolvedFrom(context.linkedRunner, 'run');
  const processRunnerIds = context.processRunnerIds ?? [];
  if (processRunnerIds.length === 1) return resolvedFrom(processRunnerIds[0], 'process');
  return { runnerId: null, source: 'generic', profile: null };
}

const PROFILE_SOURCE_LABELS: Record<RunnerKeyProfileSource, string> = {
  saved: 'saved',
  run: 'from run',
  process: 'detected',
  generic: 'auto',
};

export function runnerKeyProfileSummary(resolved: ResolvedRunnerKeyProfile): string {
  const name = resolved.profile?.label ?? resolved.runnerId ?? 'none';
  return `Runner: ${name} · ${PROFILE_SOURCE_LABELS[resolved.source]}`;
}

export function workerTerminalRunnerContext(
  worker: TmuxWorkerRef | null,
  pane: Pick<TmuxWorkerSummary, 'processRunnerIds'> | null,
  linkedRun: Pick<Run, 'metrics'> | null,
): TerminalRunnerContext {
  return {
    paneKey: worker ? tmuxWorkerWatchId(worker) : null,
    linkedRunner: linkedRun?.metrics?.runner ?? null,
    processRunnerIds: pane?.processRunnerIds,
  };
}

/** Slot terminals type into the active pane of the slot's tmux session. */
export function slotTerminalRunnerContext(
  slot: Pick<SlotStatus, 'machine' | 'session' | 'slot'> | undefined,
  run: Pick<Run, 'metrics'> | null,
  windows: readonly TmuxWindow[],
): TerminalRunnerContext {
  const pane = windows.find((window) => window.active)?.panes.find((entry) => entry.active);
  return {
    paneKey: slot
      ? tmuxWorkerWatchId({ nodeId: slot.machine, target: slot.session ?? slot.slot })
      : null,
    linkedRunner: run?.metrics?.runner ?? null,
    processRunnerIds: pane?.processRunnerIds,
  };
}

export interface TerminalPaletteEntry {
  id: string;
  label: string;
  data: string;
}

const PALETTE_ARROWS = [
  ['up', 'A', '↑'],
  ['down', 'B', '↓'],
  ['right', 'C', '→'],
  ['left', 'D', '←'],
] as const;

// xterm modifier parameter: 1 + (Shift 1, Alt 2, Ctrl 4).
const PALETTE_MODIFIERS = [
  ['shift', 2, '⇧'],
  ['alt', 3, '⌥'],
  ['ctrl', 5, '^'],
] as const;

/** Every sequence a custom key may send. Custom keys store the palette id, never bytes. */
export const TERMINAL_KEY_PALETTE: readonly TerminalPaletteEntry[] = [
  ...PALETTE_MODIFIERS.flatMap(([modifier, code, glyph]) =>
    PALETTE_ARROWS.map(([direction, final, arrow]) => ({
      id: `${modifier}+${direction}`,
      label: `${glyph}${arrow}`,
      data: `\x1b[1;${code}${final}`,
    })),
  ),
  ...Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(97 + index);
    return {
      id: `ctrl+${letter}`,
      label: `^${letter.toUpperCase()}`,
      data: String.fromCharCode(index + 1),
    };
  }),
];

const PALETTE_BY_ID = new Map(TERMINAL_KEY_PALETTE.map((entry) => [entry.id, entry]));

export const MAX_TERMINAL_CUSTOM_KEYS = 8;
export const MAX_TERMINAL_CUSTOM_KEY_LABEL_LENGTH = 16;

export interface TerminalCustomKey {
  label: string;
  /** `TERMINAL_KEY_PALETTE` id. */
  sequence: string;
  danger: boolean;
}

export type TerminalCustomKeysResult =
  | { ok: true; keys: TerminalCustomKey[] }
  | { ok: false; error: string };

export function addTerminalCustomKey(
  keys: readonly TerminalCustomKey[],
  draft: TerminalCustomKey,
): TerminalCustomKeysResult {
  const label = draft.label.trim();
  if (!label) return { ok: false, error: 'Give the key a label.' };
  if (label.length > MAX_TERMINAL_CUSTOM_KEY_LABEL_LENGTH) {
    return {
      ok: false,
      error: `Labels are at most ${MAX_TERMINAL_CUSTOM_KEY_LABEL_LENGTH} characters.`,
    };
  }
  if (keys.some((key) => key.label === label)) {
    return { ok: false, error: `“${label}” is already one of your keys.` };
  }
  if (!PALETTE_BY_ID.has(draft.sequence)) return { ok: false, error: 'Pick a key to send.' };
  if (keys.length >= MAX_TERMINAL_CUSTOM_KEYS) {
    return { ok: false, error: `You can keep up to ${MAX_TERMINAL_CUSTOM_KEYS} keys.` };
  }
  return { ok: true, keys: [...keys, { label, sequence: draft.sequence, danger: draft.danger }] };
}

export function removeTerminalCustomKey(
  keys: readonly TerminalCustomKey[],
  label: string,
): TerminalCustomKey[] {
  return keys.filter((key) => key.label !== label);
}

/** Rebuilds stored keys through `addTerminalCustomKey`, dropping entries it would reject. */
export function normalizeTerminalCustomKeys(value: unknown): TerminalCustomKey[] {
  if (!Array.isArray(value)) return [];
  let keys: TerminalCustomKey[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { label, sequence, danger } = entry as Record<string, unknown>;
    if (typeof label !== 'string' || typeof sequence !== 'string') continue;
    const result = addTerminalCustomKey(keys, { label, sequence, danger: danger === true });
    if (result.ok) keys = result.keys;
  }
  return keys;
}

/** Keeps only overrides that name a runner with a key profile. */
export function normalizeRunnerKeyOverrides(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && runnerMobileKeyProfile(entry[1]) !== null,
    ),
  );
}

export interface TerminalKeyRow {
  id: 'runner' | 'custom';
  title: string;
  keys: TerminalControlKey[];
}

/** Extra rows below the generic keys: the runner row when its profile has keys, then Yours. */
export function terminalExtraKeyRows(
  profile: RunnerMobileKeyProfile | null,
  customKeys: readonly TerminalCustomKey[],
): TerminalKeyRow[] {
  const rows: TerminalKeyRow[] = [];
  if (profile && profile.keys.length > 0) {
    rows.push({
      id: 'runner',
      title: profile.label,
      keys: profile.keys.map(({ label, data, danger }) => ({ label, data, danger })),
    });
  }
  const custom = customKeys.flatMap((key) => {
    const entry = PALETTE_BY_ID.get(key.sequence);
    return entry ? [{ label: key.label, data: entry.data, danger: key.danger }] : [];
  });
  if (custom.length > 0) rows.push({ id: 'custom', title: 'Yours', keys: custom });
  return rows;
}
