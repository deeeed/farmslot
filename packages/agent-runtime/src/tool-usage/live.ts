// Live tokens, cost, compactions and tool calls of a running session, from the transcript bytes
// appended since the last read. A step a checklist mark has closed is frozen and its events are
// dropped, so each summary counts only the open step: the cost does not grow with the session.
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

function streamTotals(stream: ToolUsageStream): Totals {
  let costUsd: number | null = 0;
  let tokens = 0;
  for (const sample of stream.tokens ?? []) {
    tokens += sample.tokens;
    costUsd = add(costUsd, sample.costUsd);
  }
  return {
    tokens,
    costUsd,
    compactions: stream.compactions?.length ?? 0,
    toolCalls: stream.tools.length,
  };
}

export class LiveToolUsage {
  /** Byte offset of the first unread byte. */
  offset = 0;
  /** The transcript incarnation being read; another one starts the count again. */
  fileIdentity?: string;
  private carry = '';
  private parser: StreamParser;
  private frozen: SessionToolUsageSegment[] = [];
  private frozenUntil = -Infinity;
  private frozenTotals: Totals = { tokens: 0, costUsd: 0, compactions: 0, toolCalls: 0 };

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
    this.frozenUntil = -Infinity;
    this.frozenTotals = { tokens: 0, costUsd: 0, compactions: 0, toolCalls: 0 };
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

  summary(marks: ChecklistMark[]): LiveUsageSummary {
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
      ...stream.tools.flatMap((tool) => (tool.issuedAt ? [Date.parse(tool.issuedAt)] : [])),
      ...(stream.tokens ?? []).map((sample) => Date.parse(sample.at)),
      -Infinity,
    );
    const steps = usage.steps.filter(
      (step) => !(step.markedAt !== undefined && Date.parse(step.markedAt) <= this.frozenUntil),
    );
    const closed = steps.filter(
      (step) => step.markedAt !== undefined && Date.parse(step.markedAt) <= latest,
    );
    if (closed.length) {
      // The transcript is read past these marks: their steps cannot change any more.
      this.frozen.push(...closed);
      for (const step of closed) {
        this.frozenTotals = {
          tokens: this.frozenTotals.tokens + (step.totalTokens ?? 0),
          costUsd: add(this.frozenTotals.costUsd, step.costUsd),
          compactions: this.frozenTotals.compactions + (step.compactions ?? 0),
          toolCalls: this.frozenTotals.toolCalls + step.toolCalls,
        };
      }
      this.frozenUntil = Date.parse(closed[closed.length - 1].markedAt!);
      this.parser.dropBefore(this.frozenUntil);
    }
    const rest = streamTotals(this.parser.stream());
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
