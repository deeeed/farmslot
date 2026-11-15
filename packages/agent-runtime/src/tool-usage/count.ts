// Counts tool calls, tokens and wall time from the normalized stream, split at checklist marks.
// Runner-agnostic: adapters produce the stream, the mark ledger supplies the boundaries.
import type { SessionToolUsage, SessionToolUsageSegment } from '@farmslot/protocol/contracts/runs';

import type { ChecklistMark } from './ledger.js';
import type { ToolUsageStream } from './stream.js';

export type ToolUsageSegment = SessionToolUsageSegment;
export type ToolUsage = SessionToolUsage;

export interface ToolUsageWindow {
  startedAt?: string;
  completedAt?: string;
}

function add(counts: Record<string, number>, name: string, n = 1): void {
  counts[name] = (counts[name] ?? 0) + n;
}

function inWindow(time: number, start: number, end: number): boolean {
  return time >= start && time <= end;
}

export function countToolUsage(
  stream: ToolUsageStream,
  marks: ChecklistMark[],
  window: ToolUsageWindow = {},
): ToolUsage {
  const times = [
    ...stream.tools.flatMap((tool) => (tool.issuedAt ? [Date.parse(tool.issuedAt)] : [])),
    ...(stream.tokens ?? []).map((sample) => Date.parse(sample.at)),
  ].filter(Number.isFinite);
  const start = window.startedAt ? Date.parse(window.startedAt) : Math.min(...times);
  // A mark after the last recorded activity still closes its step.
  const markTimes = marks.map((mark) => Date.parse(mark.checkedAt)).filter(Number.isFinite);
  const end = window.completedAt
    ? Date.parse(window.completedAt)
    : Math.max(...times, ...markTimes);
  const windowed = window.startedAt !== undefined || window.completedAt !== undefined;

  const usage: ToolUsage = {
    attribution: 'issuedAt',
    toolCalls: 0,
    toolCallsByName: {},
    toolCallsBeforeFirstMark: null,
    untimedToolCalls: 0,
    steps: [],
  };
  const timed: Array<{ at: number; name: string }> = [];
  for (const tool of stream.tools) {
    const at = tool.issuedAt ? Date.parse(tool.issuedAt) : NaN;
    if (!Number.isFinite(at)) {
      // Without a time the call cannot be placed in a run window or a step.
      if (windowed) continue;
      usage.untimedToolCalls += 1;
    } else if (!inWindow(at, start, end)) continue;
    else timed.push({ at, name: tool.name });
    usage.toolCalls += 1;
    add(usage.toolCallsByName, tool.name);
  }
  const tokens = (stream.tokens ?? [])
    .map((sample) => ({ at: Date.parse(sample.at), tokens: sample.tokens }))
    .filter((sample) => Number.isFinite(sample.at) && inWindow(sample.at, start, end));

  const boundaries = marks
    .map((mark) => ({ mark, at: Date.parse(mark.checkedAt) }))
    .filter(({ at }) => Number.isFinite(at) && inWindow(at, start, end))
    .sort((a, b) => a.at - b.at);
  if (!boundaries.length || !Number.isFinite(start) || !Number.isFinite(end)) {
    usage.stepsUnavailable =
      usage.untimedToolCalls && !timed.length
        ? 'The transcript records no call times, so calls cannot be placed in steps'
        : 'The session has no checklist marks';
    return usage;
  }

  const edges = [
    ...boundaries.map(({ mark, at }, index) => ({
      segment: index === 0 ? ('before-first-mark' as const) : ('step' as const),
      mark,
      at,
    })),
    { segment: 'after-last-mark' as const, mark: undefined, at: end },
  ];
  // The first segment starts at the session's first activity, not at the run's dispatch.
  const active = times.filter((at) => inWindow(at, start, end));
  let from = active.length ? Math.min(...active) : start;
  for (const [index, edge] of edges.entries()) {
    const last = index === edges.length - 1;
    // A segment holds [from, edge.at); the last one also holds the end instant.
    const inside = (at: number) => at >= from && (last ? at <= edge.at : at < edge.at);
    const segment: ToolUsageSegment = {
      segment: edge.segment,
      ...(edge.mark ? { stepNumber: edge.mark.stepNumber, title: edge.mark.label } : {}),
      startedAt: new Date(from).toISOString(),
      endedAt: new Date(edge.at).toISOString(),
      wallMs: Math.max(0, edge.at - from),
      toolCalls: 0,
      toolCallsByName: {},
      totalTokens: stream.tokens ? 0 : null,
    };
    for (const tool of timed)
      if (inside(tool.at)) {
        segment.toolCalls += 1;
        add(segment.toolCallsByName, tool.name);
      }
    for (const sample of tokens)
      if (inside(sample.at)) segment.totalTokens = (segment.totalTokens ?? 0) + sample.tokens;
    usage.steps.push(segment);
    from = edge.at;
  }
  usage.toolCallsBeforeFirstMark = usage.steps[0].toolCalls;
  return usage;
}

/** Sums the usage of several sessions of one run. They share one ledger, so segments align. */
export function mergeToolUsage(usages: ToolUsage[]): ToolUsage | null {
  if (!usages.length) return null;
  const merged: ToolUsage = {
    attribution: 'issuedAt',
    toolCalls: 0,
    toolCallsByName: {},
    toolCallsBeforeFirstMark: null,
    untimedToolCalls: 0,
    steps: [],
  };
  const steps = new Map<string, ToolUsageSegment>();
  for (const usage of usages) {
    merged.toolCalls += usage.toolCalls;
    merged.untimedToolCalls += usage.untimedToolCalls;
    for (const [name, n] of Object.entries(usage.toolCallsByName))
      add(merged.toolCallsByName, name, n);
    for (const step of usage.steps) {
      // Marks end every segment but the last, whose end is each session's own end.
      const key =
        step.segment === 'after-last-mark' ? 'end' : `mark:${step.endedAt}:${step.stepNumber}`;
      const known = steps.get(key);
      if (!known) {
        steps.set(key, { ...step, toolCallsByName: { ...step.toolCallsByName } });
        continue;
      }
      known.toolCalls += step.toolCalls;
      known.totalTokens =
        known.totalTokens === null || step.totalTokens === null
          ? null
          : known.totalTokens + step.totalTokens;
      for (const [name, n] of Object.entries(step.toolCallsByName))
        add(known.toolCallsByName, name, n);
      if (step.startedAt < known.startedAt) known.startedAt = step.startedAt;
      if (step.endedAt > known.endedAt) known.endedAt = step.endedAt;
      known.wallMs = Date.parse(known.endedAt) - Date.parse(known.startedAt);
    }
  }
  const ordered = [...steps.values()].filter((step) => step.segment !== 'after-last-mark');
  ordered.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  // A later session's first segment is a middle step of the run.
  ordered.forEach((step, index) => (step.segment = index ? 'step' : 'before-first-mark'));
  merged.steps = [
    ...ordered,
    ...[...steps.values()].filter((s) => s.segment === 'after-last-mark'),
  ];
  merged.toolCallsBeforeFirstMark = ordered[0]?.toolCalls ?? null;
  if (!merged.steps.length)
    merged.stepsUnavailable = usages.find((usage) => usage.stepsUnavailable)?.stepsUnavailable;
  return merged;
}
