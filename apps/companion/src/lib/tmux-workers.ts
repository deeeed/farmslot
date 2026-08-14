import type {
  TmuxWorkerNodeResult,
  TmuxWorkerRef,
  TmuxWorkerSummary,
  TmuxWorkerWatchEntry,
} from '@farmslot/protocol';

import { type GlobalFilters, normalizeFilters } from '../store/filters';

type TmuxWorkerActivityState = 'active' | 'waiting' | 'idle' | 'stale' | 'unknown';

type TmuxWorkerWithObservability = TmuxWorkerSummary & {
  branch?: string;
  status: TmuxWorkerSummary['status'] & { state?: TmuxWorkerActivityState };
};

type TmuxWorkerNodeWithSummary = TmuxWorkerNodeResult & {
  summary?: {
    panes: number;
    active: number;
    waiting: number;
    idle: number;
    stale: number;
    unknown: number;
  };
};

export type TmuxWorkerListItem =
  | { type: 'header'; node: TmuxWorkerNodeResult }
  | {
      type: 'window';
      sessionKey: string;
      windowKey: string;
      window: string;
      windowName?: string;
      paneCount: number;
    }
  | {
      type: 'worker';
      worker: TmuxWorkerSummary;
      role: 'primary' | 'sibling' | 'shell';
      sessionKey: string;
      sessionPaneCount: number;
      siblingCount: number;
      expanded: boolean;
      isActive: boolean;
      isShell: boolean;
    };

const AGENT_COMMANDS = new Set(['claude', 'codex', 'gemini', 'aider']);
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);

function paneHasSignals(pane: TmuxWorkerSummary): boolean {
  return pane.status.source !== 'tmux';
}

export function tmuxWorkerIsShell(pane: TmuxWorkerSummary): boolean {
  const command = (pane.command ?? '').toLowerCase();
  return SHELL_COMMANDS.has(command) && !paneHasSignals(pane);
}

function paneScore(pane: TmuxWorkerSummary): number {
  const command = (pane.command ?? '').toLowerCase();
  let score = 0;
  if (paneHasSignals(pane)) score += 8;
  if (AGENT_COMMANDS.has(command) || command === 'node') score += 4;
  if (pane.active === true) score += 2;
  if (!SHELL_COMMANDS.has(command)) score += 1;
  return score;
}

export function tmuxWorkerSessionKey(nodeId: string, session: string): string {
  return `${nodeId}::${session}`;
}

export function tmuxWorkerTitle(worker: TmuxWorkerSummary): string {
  // Title = tmux session name (matches `tmux ls`). Window:pane lives on a
  // separate row via `tmuxWorkerRefLabel`.
  return worker.ref.session || worker.title || worker.command || 'unknown';
}

function meaningfulTmuxPaneTitle(
  title: string | undefined,
  context: { cwd?: string; nodeId: string; session: string },
): string | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  const cwdParts = context.cwd?.split('/').filter(Boolean) ?? [];
  const cwdBase = cwdParts[cwdParts.length - 1];
  const lowSignal = new Set([
    context.nodeId,
    context.session,
    cwdBase,
    'ad-hoc',
    'ad hoc',
    'ad-hoc codex',
    'ad hoc codex',
    'bash',
    'zsh',
    'sh',
    'fish',
    'tmux',
  ]);
  return lowSignal.has(trimmed.toLowerCase()) || lowSignal.has(trimmed) ? null : trimmed;
}

export function tmuxWorkerRefLabel(worker: TmuxWorkerSummary, sessionPaneCount?: number): string {
  const window = worker.ref.window ?? '0';
  const pane = worker.ref.pane ?? '0';
  const base = `${window}:${pane}`;
  if (sessionPaneCount && sessionPaneCount >= 2) {
    return `${base} · ${sessionPaneCount} panes`;
  }
  return base;
}

export function tmuxWorkerSubtitle(worker: TmuxWorkerSummary): string {
  const observedWorker = worker as TmuxWorkerWithObservability;
  return [worker.cwd, observedWorker.branch, worker.linkedSlotId].filter(Boolean).join(' · ');
}

export function tmuxWorkerStateLabel(worker: TmuxWorkerSummary): string {
  const observedWorker = worker as TmuxWorkerWithObservability;
  return observedWorker.status.state ?? worker.status.source;
}

export function tmuxWorkerStateTone(worker: TmuxWorkerSummary): 'ok' | 'warn' | 'muted' {
  const state = (worker as TmuxWorkerWithObservability).status.state;
  if (state === 'active') return 'ok';
  if (state === 'waiting') return 'warn';
  return 'muted';
}

export function tmuxWorkerNodeSummaryLabel(node: TmuxWorkerNodeResult): string {
  if (!node.ok) return node.error || 'degraded';
  const summary = (node as TmuxWorkerNodeWithSummary).summary;
  if (!summary) {
    const count = node.workers.length;
    return `${count} pane${count === 1 ? '' : 's'}`;
  }
  const parts = [
    `${summary.panes} pane${summary.panes === 1 ? '' : 's'}`,
    summary.active > 0 ? `${summary.active} active` : null,
    summary.waiting > 0 ? `${summary.waiting} waiting` : null,
    summary.idle > 0 ? `${summary.idle} idle` : null,
    summary.stale > 0 ? `${summary.stale} stale` : null,
    summary.unknown > 0 ? `${summary.unknown} unknown` : null,
    node.hiddenWorkers && node.hiddenWorkers > 0 ? `${node.hiddenWorkers} hidden` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function filterTmuxWorkerNodes(
  nodes: TmuxWorkerNodeResult[],
  filters: GlobalFilters,
): TmuxWorkerNodeResult[] {
  const normalized = normalizeFilters(filters);
  if (normalized.machines.length === 0) return nodes;
  return nodes.filter((node) => normalized.machines.includes(node.nodeId));
}

type SessionGroup = {
  sessionKey: string;
  session: string;
  panes: TmuxWorkerSummary[];
  primaryIndex: number;
};

function groupNodePanesBySession(
  nodeId: string,
  workers: readonly TmuxWorkerSummary[],
): SessionGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, SessionGroup>();
  for (const worker of workers) {
    const session = worker.ref.session ?? '';
    const sessionKey = tmuxWorkerSessionKey(nodeId, session);
    let group = byKey.get(sessionKey);
    if (!group) {
      group = { sessionKey, session, panes: [], primaryIndex: 0 };
      byKey.set(sessionKey, group);
      order.push(sessionKey);
    }
    group.panes.push(worker);
  }
  for (const group of byKey.values()) {
    // Highest paneScore wins; ties resolved by first appearance (stable scan).
    let bestIdx = 0;
    let bestScore = paneScore(group.panes[0]!);
    for (let i = 1; i < group.panes.length; i += 1) {
      const score = paneScore(group.panes[i]!);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    group.primaryIndex = bestIdx;
  }
  return order.map((key) => byKey.get(key)!);
}

type WindowSlice = {
  windowKey: string;
  window: string;
  windowName?: string;
  panes: { index: number; pane: TmuxWorkerSummary }[];
};

function sliceGroupByWindow(group: SessionGroup): WindowSlice[] {
  const order: string[] = [];
  const byKey = new Map<string, WindowSlice>();
  for (let i = 0; i < group.panes.length; i += 1) {
    const pane = group.panes[i]!;
    const window = pane.ref.window ?? '0';
    const windowKey = `${group.sessionKey}::w${window}`;
    let slice = byKey.get(windowKey);
    if (!slice) {
      slice = {
        windowKey,
        window,
        ...(pane.ref.windowName ? { windowName: pane.ref.windowName } : {}),
        panes: [],
      };
      byKey.set(windowKey, slice);
      order.push(windowKey);
    }
    slice.panes.push({ index: i, pane });
  }
  return order.map((key) => byKey.get(key)!);
}

export function buildTmuxWorkerRows(
  nodes: TmuxWorkerNodeResult[],
  expandedSessions: ReadonlySet<string> = new Set(),
): TmuxWorkerListItem[] {
  const rows: TmuxWorkerListItem[] = [];
  for (const node of nodes) {
    rows.push({ type: 'header', node });
    if (!node.ok) continue;
    const groups = groupNodePanesBySession(node.nodeId, node.workers);
    for (const group of groups) {
      const siblingCount = group.panes.length - 1;
      const expanded = expandedSessions.has(group.sessionKey);
      const primary = group.panes[group.primaryIndex];
      if (!primary) continue;
      rows.push({
        type: 'worker',
        worker: primary,
        role: 'primary',
        sessionKey: group.sessionKey,
        sessionPaneCount: group.panes.length,
        siblingCount,
        expanded,
        isActive: primary.active === true,
        isShell: tmuxWorkerIsShell(primary),
      });
      if (!expanded || siblingCount === 0) continue;
      const windowSlices = sliceGroupByWindow(group);
      const multiWindow = windowSlices.length > 1;
      for (const slice of windowSlices) {
        // Skip windows that only contain the primary pane — no siblings to show.
        const siblingsInSlice = slice.panes.filter((entry) => entry.index !== group.primaryIndex);
        if (siblingsInSlice.length === 0) continue;
        if (multiWindow) {
          rows.push({
            type: 'window',
            sessionKey: group.sessionKey,
            windowKey: slice.windowKey,
            window: slice.window,
            ...(slice.windowName ? { windowName: slice.windowName } : {}),
            paneCount: slice.panes.length,
          });
        }
        for (const entry of siblingsInSlice) {
          const sibling = entry.pane;
          const isShell = tmuxWorkerIsShell(sibling);
          rows.push({
            type: 'worker',
            worker: sibling,
            role: isShell ? 'shell' : 'sibling',
            sessionKey: group.sessionKey,
            sessionPaneCount: group.panes.length,
            siblingCount,
            expanded,
            isActive: sibling.active === true,
            isShell,
          });
        }
      }
    }
  }
  return rows;
}
export function firstRouteParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseWorkerRefParam(value: string | undefined): TmuxWorkerRef | null {
  if (!value) return null;
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) candidates.push(decoded);
  } catch {
    // Legacy routes can contain raw '%' tmux pane ids. If the encoded worker ref
    // cannot be decoded as a URI component, fall back to individual route params.
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<TmuxWorkerRef> | null;
      if (parsed?.nodeId && parsed.session && parsed.target) {
        return {
          nodeId: parsed.nodeId,
          session: parsed.session,
          target: parsed.target,
          ...(parsed.window ? { window: parsed.window } : {}),
          ...(parsed.windowName ? { windowName: parsed.windowName } : {}),
          ...(parsed.pane ? { pane: parsed.pane } : {}),
          ...(parsed.paneId ? { paneId: parsed.paneId } : {}),
        };
      }
    } catch {
      // Try the next representation; invalid deep links still fall through to
      // the legacy param parser below.
    }
  }
  return null;
}

export function tmuxWorkerRefFromRouteParams(
  params: Record<string, string | string[] | undefined>,
): TmuxWorkerRef | null {
  const encodedRef = parseWorkerRefParam(firstRouteParam(params.workerRef));
  if (encodedRef) return encodedRef;

  const nodeId = firstRouteParam(params.nodeId);
  const session = firstRouteParam(params.session);
  const target = firstRouteParam(params.target);
  if (!nodeId || !session || !target) return null;
  return {
    nodeId,
    session,
    target,
    ...(firstRouteParam(params.window) ? { window: firstRouteParam(params.window) } : {}),
    ...(firstRouteParam(params.windowName)
      ? { windowName: firstRouteParam(params.windowName) }
      : {}),
    ...(firstRouteParam(params.pane) ? { pane: firstRouteParam(params.pane) } : {}),
    ...(firstRouteParam(params.paneId) ? { paneId: firstRouteParam(params.paneId) } : {}),
  };
}

export function tmuxWorkerRouteParams(worker: TmuxWorkerSummary): Record<string, string> {
  return tmuxWorkerRouteParamsFromRef(worker.ref, tmuxWorkerTitle(worker));
}

export function tmuxWorkerRouteParamsFromRef(
  ref: TmuxWorkerRef,
  title?: string,
): Record<string, string> {
  return {
    workerRef: encodeURIComponent(JSON.stringify(ref)),
    nodeId: ref.nodeId,
    session: ref.session,
    target: ref.target,
    ...(ref.window ? { window: ref.window } : {}),
    ...(ref.windowName ? { windowName: ref.windowName } : {}),
    ...(ref.pane ? { pane: ref.pane } : {}),
    ...(ref.paneId ? { paneId: ref.paneId } : {}),
    ...(title ? { title } : {}),
  };
}

function tmuxRefTitle(ref: TmuxWorkerRef): string {
  const window = ref.window ?? '0';
  const pane = ref.pane ?? ref.paneId ?? ref.target;
  const paneLabel = pane.startsWith('%') ? pane : `${window}:${pane}`;
  return `${ref.session || 'tmux'} · ${paneLabel}`;
}

export function tmuxWorkerWatchEntryTitle(entry: TmuxWorkerWatchEntry): string {
  return tmuxRefTitle(entry.worker?.ref ?? entry.ref);
}

export function tmuxWorkerWatchEntrySubtitle(entry: TmuxWorkerWatchEntry): string {
  if (entry.worker) return tmuxWorkerSubtitle(entry.worker);
  const title = meaningfulTmuxPaneTitle(entry.item.title, {
    cwd: entry.item.cwd,
    nodeId: entry.ref.nodeId,
    session: entry.ref.session,
  });
  return [title, entry.item.statusLabel, entry.item.branch, entry.item.cwd, entry.item.command]
    .filter(Boolean)
    .join(' · ');
}
