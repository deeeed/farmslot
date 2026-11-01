import type { CopilotRuntimeSession } from '@farmslot/protocol';

/** Co-Pilot's status line. Offline with nothing saved, it stays empty: the banner says why. */
export function copilotStatusLine(
  runtime: Pick<CopilotRuntimeSession, 'status'> | null,
  connected: boolean,
  loading: boolean,
): string {
  if (runtime) return `Co-Pilot is ${runtime.status}`;
  if (!connected) return '';
  return loading ? 'Finding Co-Pilot…' : 'Co-Pilot unavailable';
}
