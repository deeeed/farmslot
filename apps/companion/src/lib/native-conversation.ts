import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionReadResult,
} from '@farmslot/protocol';

export interface NativeTranscript {
  events: NativeSessionEvent[];
  cursor: number;
}

/** Page sequence is authoritative. Ignore repeats; reject a gap rather than hide missing history. */
export function appendNativePage(
  previous: NativeTranscript,
  page: NativeSessionReadResult,
): NativeTranscript {
  const events = [...previous.events];
  let cursor = previous.cursor;
  for (const event of page.events) {
    if (event.sessionId !== page.session.id) throw new Error('Native replay changed session');
    if (event.sequence <= cursor) continue;
    if (event.sequence !== cursor + 1)
      throw new Error('Native history has a gap. Reload this session.');
    events.push(event);
    cursor = event.sequence;
  }
  return cursor === previous.cursor ? previous : { events, cursor };
}

export function nativeDeliveryLabel(receipt?: NativeCommandReceipt): string {
  if (!receipt) return 'Delivery unknown';
  if (receipt.outcome === 'interrupted') return 'Interrupted';
  switch (receipt.state) {
    case 'pending':
      return 'Submitting';
    case 'unknown':
      return 'Awaiting runner acceptance';
    case 'accepted':
      return 'Accepted';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
  }
}

export interface NativeTimelineEntry {
  key: number;
  kind: 'user' | 'assistant' | 'tool' | 'status';
  event: NativeSessionEvent;
  text: string;
}

export function nativeTimeline(events: NativeSessionEvent[]): NativeTimelineEntry[] {
  const entries: NativeTimelineEntry[] = [];
  const userCommands = new Set<string>();
  const tools = new Map<string, NativeTimelineEntry>();
  const prompts = new Map<string, NativeSessionEvent>();
  for (const event of events) {
    if (
      (event.type === 'command.submitted' || event.type === 'command.accepted') &&
      event.commandId &&
      event.text !== undefined &&
      !prompts.has(event.commandId)
    )
      prompts.set(event.commandId, event);
  }
  for (const event of events) {
    if (event.commandId && !userCommands.has(event.commandId)) {
      const prompt = prompts.get(event.commandId);
      if (prompt) {
        userCommands.add(event.commandId);
        entries.push({ key: prompt.sequence, kind: 'user', event: prompt, text: prompt.text! });
      }
    }
    if (event.type === 'text.delta') {
      const last = entries.at(-1);
      if (
        last?.kind === 'assistant' &&
        last.event.commandId === event.commandId &&
        last.event.generation === event.generation
      ) {
        last.text += event.text ?? '';
      } else
        entries.push({ key: event.sequence, kind: 'assistant', event, text: event.text ?? '' });
    } else if (event.type === 'tool.started' || event.type === 'tool.completed') {
      const identity =
        event.nativeId && JSON.stringify([event.generation, event.commandId, event.nativeId]);
      const previous = identity ? tools.get(identity) : undefined;
      if (previous) {
        const completed = previous.event.type === 'tool.completed' ? previous.event : event;
        const started = event.type === 'tool.started' ? event : previous.event;
        previous.event = {
          ...completed,
          tool: {
            ...started.tool,
            ...completed.tool,
            name: started.tool?.name ?? completed.tool?.name ?? 'Tool',
          },
        };
      } else {
        const entry: NativeTimelineEntry = {
          key: event.sequence,
          kind: 'tool',
          event,
          text: event.tool?.name ?? 'Tool',
        };
        entries.push(entry);
        if (identity) tools.set(identity, entry);
      }
    } else if (['turn.completed', 'session.closed', 'error'].includes(event.type)) {
      entries.push({
        key: event.sequence,
        kind: 'status',
        event,
        text:
          event.text ??
          (event.type === 'session.closed'
            ? `Session ${event.status ?? 'closed'}`
            : event.type === 'error'
              ? 'Runner error'
              : `Turn ${event.status ?? 'completed'}`),
      });
    }
  }
  return entries;
}

/** A confirmed replacement generation must not inherit the old browser input lock. */
export function nativeCommandLockSettled(
  command: { commandId: string; generation: string },
  currentGeneration: string,
  receipt?: NativeCommandReceipt,
  events: NativeSessionEvent[] = [],
): boolean {
  return (
    command.generation !== currentGeneration ||
    (!!receipt &&
      receipt.commandId === command.commandId &&
      receipt.generation === command.generation &&
      ['completed', 'failed'].includes(receipt.state)) ||
    events.some(
      (event) =>
        event.type === 'turn.completed' &&
        event.commandId === command.commandId &&
        event.generation === command.generation,
    )
  );
}
