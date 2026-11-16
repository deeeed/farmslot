// Live tokens, cost, compactions and tool calls of a running session, from the transcript bytes
// appended since the last read. A step a checklist mark has closed is frozen and its events are
// dropped, so each summary counts only the open step: the cost does not grow with the session.
// An event appended later but timed inside a frozen step (a Codex command that started before
// the mark) is added to that step rather than lost.
import type { SessionToolUsageSegment } from '@farmslot/protocol/contracts/runs';

import { countToolUsage } from './count.js';
import type { ChecklistMark } from './ledger.js';
import type { StreamParser, ToolUsageStream } from './stream.js';

export interface LiveUsageSummary {
  runner: string;
  /** Null when the runner records no timed token usage. */
  totalTokens: number | null;
  /** Null when any token record has no recorded or listed price. */
  costUsd: number | null;
  /** Null when the runner records no compaction events. */
  compactions: number | null;
  toolCalls: number;
  /** Closed steps, then the open one (after the last mark). Empty before the first mark is read. */
  steps: SessionToolUsageSegment[];
}

interface Totals {
  tokens: number;
  costUsd: number | null;
  compactions: number;
  toolCalls: number;
}

const add = (a: number | null, b: number | null | undefined) =>
  a === null || b == null ? null : a + b;
const zero = (): Totals => ({ tokens: 0, costUsd: 0, compactions: 0, toolCalls: 0 });
const ms = (at: string | undefined) => (at ? Date.parse(at) : NaN);

/** Totals of the events at or after `from`. */
function streamTotals(stream: ToolUsageStream, from: number): Totals {
  const totals = zero();
  for (const sample of stream.tokens ?? [])
    if (!(ms(sample.at) < from)) {
      totals.tokens += sample.tokens;
      totals.costUsd = add(totals.costUsd, sample.costUsd);
    }
  totals.compactions = (stream.compactions ?? []).filter((event) => !(ms(event.at) < from)).length;
  totals.toolCalls = stream.tools.filter((tool) => !(ms(tool.issuedAt) < from)).length;
  return totals;
}

export class LiveToolUsage {
  /** Byte offset of the first unread byte. */
  offset = 0;
  /** The transcript incarnation being read; another one starts the count again. */
  fileIdentity?: string;
  private carry = '';
  private parser: StreamParser;
  private frozen: SessionToolUsageSegment[] = [];
  /** End (mark time) of each frozen step, ascending. */
  private boundaries: number[] = [];
  private frozenUntil = -Infinity;
  private frozenTotals: Totals = zero();

  constructor(
    readonly runner: string,
    private readonly makeParser: () => StreamParser,
  ) {
    this.parser = makeParser();
  }

  /** Start again from byte 0, for a replaced transcript. */
  reset(fileIdentity?: string): void {
    this.offset = 0;
    this.fileIdentity = fileIdentity;
    this.carry = '';
    this.parser = this.makeParser();
    this.frozen = [];
    this.boundaries = [];
    this.frozenUntil = -Infinity;
    this.frozenTotals = zero();
  }

  /** Bytes read at `this.offset`. A partial last line waits for the next read. */
  append(bytes: Buffer): void {
    this.offset += bytes.length;
    const lines = (this.carry + bytes.toString('utf8')).split('\n');
    this.carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        // A complete line that does not parse is skipped, as the full read does.
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (value && typeof value === 'object' && !Array.isArray(value))
        this.parser.push(value as Record<string, unknown>);
    }
  }

  /**
   * Adds an event timed before the frozen boundary to the step whose mark interval holds it,
   * creating that step's segment when the first read saw no activity in it.
   */
  private routeLate(
    at: number,
    marks: ChecklistMark[],
    stream: ToolUsageStream,
    change: Partial<Totals> & { toolName?: string },
  ): void {
    const index = marks.findIndex((mark) => at < Date.parse(mark.checkedAt));
    if (index < 0) return;
    const mark = marks[index];
    let step = this.frozen.find((segment) => segment.markedAt === mark.checkedAt);
    if (!step) {
      const lower = index === 0 ? at : Math.max(at, Date.parse(marks[index - 1].checkedAt));
      step = {
        segment: index === 0 ? 'before-first-mark' : 'step',
        stepNumber: mark.stepNumber,
        title: mark.label,
        markedAt: mark.checkedAt,
        startedAt: new Date(lower).toISOString(),
        endedAt: mark.checkedAt,
        wallMs: Date.parse(mark.checkedAt) - lower,
        toolCalls: 0,
        toolCallsByName: {},
        totalTokens: stream.tokens ? 0 : null,
        compactions: stream.compactions ? 0 : null,
        costUsd: stream.tokens ? 0 : null,
      };
      this.frozen.push(step);
      this.frozen.sort((a, b) => Date.parse(a.markedAt!) - Date.parse(b.markedAt!));
    }
    const hasTokens = change.tokens !== undefined;
    if (change.toolCalls) {
      step.toolCalls += change.toolCalls;
      const name = change.toolName ?? 'unknown';
      step.toolCallsByName[name] = (step.toolCallsByName[name] ?? 0) + change.toolCalls;
    }
    if (hasTokens) {
      step.totalTokens = (step.totalTokens ?? 0) + (change.tokens ?? 0);
      // An unknown price stays unknown, as in the counter.
      step.costUsd = add(step.costUsd === undefined ? 0 : step.costUsd, change.costUsd);
    }
    if (change.compactions) step.compactions = (step.compactions ?? 0) + change.compactions;
    this.frozenTotals = {
      tokens: this.frozenTotals.tokens + (change.tokens ?? 0),
      costUsd: hasTokens
        ? add(this.frozenTotals.costUsd, change.costUsd)
        : this.frozenTotals.costUsd,
      compactions: this.frozenTotals.compactions + (change.compactions ?? 0),
      toolCalls: this.frozenTotals.toolCalls + (change.toolCalls ?? 0),
    };
  }

  /** Records appended since the last summary but timed before the frozen boundary. */
  private settleLateEvents(marks: ChecklistMark[]): void {
    if (!Number.isFinite(this.frozenUntil)) return;
    const stream = this.parser.stream();
    if (this.frozen.length) {
      const sorted = [...marks].sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
      for (const tool of stream.tools)
        if (ms(tool.issuedAt) < this.frozenUntil)
          this.routeLate(ms(tool.issuedAt), sorted, stream, { toolCalls: 1, toolName: tool.name });
      for (const sample of stream.tokens ?? [])
        if (ms(sample.at) < this.frozenUntil)
          this.routeLate(ms(sample.at), sorted, stream, {
            tokens: sample.tokens,
            costUsd: sample.costUsd ?? null,
          });
      for (const event of stream.compactions ?? [])
        if (ms(event.at) < this.frozenUntil)
          this.routeLate(ms(event.at), sorted, stream, { compactions: 1 });
    }
    this.parser.dropBefore(this.frozenUntil);
  }

  summary(marks: ChecklistMark[]): LiveUsageSummary {
    this.settleLateEvents(marks);
    const stream = this.parser.stream();
    // The last frozen mark stays, so the counter labels what follows it as a step or the tail;
    // the segment it closes was frozen already and is dropped below.
    const open = marks
      .filter((mark) => Date.parse(mark.checkedAt) >= this.frozenUntil)
      .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
    const usage = countToolUsage(
      stream,
      open,
      Number.isFinite(this.frozenUntil)
        ? { startedAt: new Date(this.frozenUntil).toISOString() }
        : {},
    );
    const latest = Math.max(
      ...stream.tools.flatMap((tool) => (tool.issuedAt ? [ms(tool.issuedAt)] : [])),
      ...(stream.tokens ?? []).map((sample) => ms(sample.at)),
      ...(stream.compactions ?? []).map((event) => ms(event.at)),
      -Infinity,
    );
    const steps = usage.steps.filter(
      (step) =>
        !(
          this.frozen.length &&
          step.markedAt !== undefined &&
          Date.parse(step.markedAt) <= this.frozenUntil
        ),
    );
    const closed = steps.filter(
      (step) => step.markedAt !== undefined && Date.parse(step.markedAt) <= latest,
    );
    for (const step of closed) {
      // Read past this mark: the step is final, except for late records routed above.
      this.frozen.push(step);
      this.boundaries.push(Date.parse(step.markedAt!));
      this.frozenTotals = {
        tokens: this.frozenTotals.tokens + (step.totalTokens ?? 0),
        costUsd: add(this.frozenTotals.costUsd, step.costUsd),
        compactions: this.frozenTotals.compactions + (step.compactions ?? 0),
        toolCalls: this.frozenTotals.toolCalls + step.toolCalls,
      };
    }
    if (closed.length) {
      this.frozenUntil = this.boundaries[this.boundaries.length - 1];
      this.parser.dropBefore(this.frozenUntil);
    }
    const rest = streamTotals(this.parser.stream(), this.frozenUntil);
    return {
      runner: this.runner,
      totalTokens: stream.tokens === null ? null : this.frozenTotals.tokens + rest.tokens,
      costUsd: stream.tokens === null ? null : add(this.frozenTotals.costUsd, rest.costUsd),
      compactions:
        stream.compactions === null ? null : this.frozenTotals.compactions + rest.compactions,
      toolCalls: this.frozenTotals.toolCalls + rest.toolCalls,
      steps: [...this.frozen, ...steps.filter((step) => !closed.includes(step))],
    };
  }
}
