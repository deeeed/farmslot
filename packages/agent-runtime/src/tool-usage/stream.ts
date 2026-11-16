// The normalized stream every runner adapter produces. Tool calls carry the same fields as the
// native `tool.started` / `tool.completed` events; token samples let per-step cost use the same
// boundaries as the tool counts.

export interface ToolCallEvent {
  /** Runner call id, used only to pair a completion with its call. */
  id?: string;
  name: string;
  /** ISO time the model issued the call. Absent when the transcript records no times. */
  issuedAt?: string;
  completedAt?: string;
}

export interface TokenSample {
  at: string;
  /** Tokens this record added (input + output + cache, as in the session totals). */
  tokens: number;
  /** USD this record cost: recorded by the runner, or priced from the static table; null when unknown. */
  costUsd?: number | null;
}

/** The runner summarized its context to free space (Claude compact_boundary, Codex compacted, ...). */
export interface CompactionEvent {
  at: string;
  /** Context tokens before the compaction, when the transcript records them. */
  tokensBefore?: number;
}

export interface ToolUsageStream {
  tools: ToolCallEvent[];
  /** Null when the runner records no timed token usage, so per-step tokens are unknown. */
  tokens: TokenSample[] | null;
  /** Null when the transcript records no compaction events; then `compactionsUnavailable` says why. */
  compactions: CompactionEvent[] | null;
  compactionsUnavailable?: string;
}

/**
 * Builds the stream one transcript record at a time, so a live reader can feed it only the
 * records appended since its last read. `dropBefore` forgets events before a time whose step
 * the live reader has already closed.
 */
export interface StreamParser {
  push(record: Record<string, unknown>): void;
  stream(): ToolUsageStream;
  dropBefore(time: number): void;
}

/** Translates one runner's transcript into the stream. Adding a runner means adding one. */
export interface ToolUsageAdapter {
  runner: string;
  /** `sessionPath` is the transcript file or session directory the usage accounting reads. */
  read(sessionPath: string, options?: { home?: string }): Promise<ToolUsageStream>;
  /** Single-file JSONL runners only: the parser `read` uses, for reading a live transcript tail. */
  parser?(): StreamParser;
}

/** Drops events before `time`; events without a time stay. */
export function dropStreamBefore(stream: ToolUsageStream, time: number): void {
  const keep = (at: string | undefined) => !at || !(Date.parse(at) < time);
  stream.tools.splice(
    0,
    stream.tools.length,
    ...stream.tools.filter((tool) => keep(tool.issuedAt)),
  );
  if (stream.tokens)
    stream.tokens.splice(
      0,
      stream.tokens.length,
      ...stream.tokens.filter((sample) => keep(sample.at)),
    );
  if (stream.compactions)
    stream.compactions.splice(
      0,
      stream.compactions.length,
      ...stream.compactions.filter((event) => keep(event.at)),
    );
}

/** Pairs completions with calls by id. Unmatched completions are ignored; they have no call. */
export function pairToolEvents(
  calls: ToolCallEvent[],
  completions: Array<{ id: string; completedAt: string }>,
): ToolCallEvent[] {
  const byId = new Map<string, ToolCallEvent>();
  for (const call of calls) if (call.id && !byId.has(call.id)) byId.set(call.id, call);
  for (const completion of completions) {
    const call = byId.get(completion.id);
    if (call && !call.completedAt) call.completedAt = completion.completedAt;
  }
  return calls;
}
