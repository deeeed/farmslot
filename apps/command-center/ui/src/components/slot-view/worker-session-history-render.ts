import type { WorkerSessionHistorySource } from '@farmslot/protocol';

export function workerHistoryShowsMessages(source: WorkerSessionHistorySource): boolean {
  return source === 'transcript' || source === 'transcript-archive';
}

export function workerHistorySourceLabel(source: WorkerSessionHistorySource): string {
  return source === 'transcript-archive' ? 'archived' : source;
}
