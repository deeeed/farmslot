import type { NativeSessionInfo, NativeSessionReadResult } from '@farmslot/protocol';

import type { NativeSessionFixture } from '../components/chat/native-session-view.js';
import type { NativeSessionApi } from '../components/chat/native-workspace.js';

/** Seeds only the dev fixture namespace before the client mounts. No live gateway calls. */
export function createNativeReplayFixture(
  base: NativeSessionInfo,
  variant: string,
): NativeSessionApi & NativeSessionFixture {
  const session = { ...base, id: `fixture-replay-${variant}`, state: 'idle' as const };
  const model = session.model ?? '';
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
    async catalog() {
      return {
        runners: [
          {
            runner: session.runner,
            models: [model],
            defaultModel: model,
            modes: ['default'],
          },
        ],
        contexts: [{ cwd: session.cwd, label: 'Replay fixture' }],
      };
    },
    async list() {
      return { sessions: [session] };
    },
    async read({ after = 0 }) {
      return { ...page, events: page.events.filter((event) => event.sequence > after) };
    },
    async request() {
      throw new Error('Replay preview accepts reads only; use a live session for execution.');
    },
  };
}
