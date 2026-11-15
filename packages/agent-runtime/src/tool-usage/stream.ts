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
}

export interface ToolUsageStream {
  tools: ToolCallEvent[];
  /** Null when the runner records no timed token usage, so per-step tokens are unknown. */
  tokens: TokenSample[] | null;
}

/** Translates one runner's transcript into the stream. Adding a runner means adding one. */
export interface ToolUsageAdapter {
  runner: string;
  /** `sessionPath` is the transcript file or session directory the usage accounting reads. */
  read(sessionPath: string, options?: { home?: string }): Promise<ToolUsageStream>;
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
