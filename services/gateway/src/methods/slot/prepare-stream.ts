import { activePrepareSessions, type EventEmitter } from './shared.js';

export interface PrepareStream {
  requestId: string;
  slotId: string;
  step: (name: string, detail: string) => void;
  output: (stream: 'stdout' | 'stderr', data: string) => void;
  complete: (exitCode: number, error?: string) => void;
}

export function createPrepareStream(
  emit: EventEmitter,
  args: { slotId: string; requestId: string; startTime: number },
): PrepareStream {
  const { slotId, requestId, startTime } = args;
  // Track this prepare's steps so a reloaded UI can re-attach (ADR-037).
  activePrepareSessions.set(slotId, { requestId, startedAt: startTime, steps: [] });
  const out = (stream: 'stdout' | 'stderr', data: string) => {
    emit('script.output', {
      requestId,
      stream,
      data: data.endsWith('\n') ? data : `${data}\n`,
      timestamp: Date.now(),
    });
    emit('slot.prepare.output', { requestId, slotId, stream, data });
  };
  return {
    requestId,
    slotId,
    step(name, detail) {
      activePrepareSessions.get(slotId)?.steps.push({ name, detail });
      emit('slot.prepare.step', { requestId, slotId, name, detail });
      out('stdout', `[${name}] ${detail}`);
    },
    output: out,
    complete(exitCode, error) {
      activePrepareSessions.delete(slotId);
      emit('script.complete', {
        requestId,
        exitCode,
        duration: Date.now() - startTime,
        ...(error ? { error } : {}),
      });
      emit('slot.prepare.done', { requestId, slotId, prepared: exitCode === 0, ...(error ? { error } : {}) });
    },
  };
}