import { Methods, type NativeSessionInfo, type NativeSessionReadResult } from '@farmslot/protocol';

import type { NativeSessionApi } from '../components/chat/native-workspace.js';

/** Seeds only the dev fixture namespace before the client mounts. No live gateway calls. */
export function createNativeReplayFixture(
  base: NativeSessionInfo,
  variant: string,
): NativeSessionApi {
  const session = { ...base, id: `fixture-replay-${variant}`, state: 'idle' as const };
  const command = {
    sessionId: session.id,
    commandId: 'old-command',
    generation: session.generation,
    text: 'Earlier command awaiting its receipt',
  };
  localStorage.setItem('farmslot-native:fixture:selected', session.id);
  localStorage.setItem(`farmslot-native:fixture:command:${session.id}`, JSON.stringify(command));
  const page: NativeSessionReadResult = {
    session,
    cursor: 2,
    hasMore: false,
    pendingRequests: [],
    commands: Array.from({ length: 100 }, (_, index) => ({
      commandId: `newer-${index}`,
      generation: session.generation,
      state: 'completed',
      submitted: true,
      accepted: true,
    })),
    events: [
      { ...command, sequence: 1, at: '2026-09-12T08:00:00Z', type: 'command.submitted' },
      {
        sessionId: session.id,
        sequence: 2,
        at: '2026-09-12T08:00:01Z',
        type: 'turn.completed',
        status: 'completed',
        commandId: variant === 'foreign-command' ? 'another-command' : command.commandId,
        generation: variant === 'foreign-generation' ? 'another-generation' : session.generation,
      },
    ],
  };
  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      let result: unknown;
      if (method === Methods.NATIVE_SESSION_CATALOG)
        result = {
          runners: [
            {
              runner: session.runner,
              models: [session.model],
              defaultModel: session.model,
              modes: ['default'],
            },
          ],
          contexts: [{ cwd: session.cwd, label: 'Replay fixture' }],
        };
      else if (method === Methods.NATIVE_SESSION_LIST) result = { sessions: [session] };
      else if (method === Methods.NATIVE_SESSION_READ) {
        const { after = 0 } = params as { after?: number };
        result = { ...page, events: page.events.filter((event) => event.sequence > after) };
      } else
        throw new Error('Replay preview accepts reads only; use a live session for execution.');
      return result as T;
    },
  };
}
