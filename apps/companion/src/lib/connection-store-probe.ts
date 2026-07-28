import {
  type ConnectionProbeIdentity,
  hasStableConnectionProbeIdentity,
} from './connection-probe-identity';

export class ConnectionProbeAttemptTracker {
  private currentAttempt = 0;

  begin(): number {
    this.currentAttempt += 1;
    return this.currentAttempt;
  }

  isCurrent(attempt: number): boolean {
    return attempt === this.currentAttempt;
  }

  invalidate(): void {
    this.currentAttempt += 1;
  }
}

export type ConnectionProbeInvalidation =
  | { kind: 'attempt'; error: string }
  | { kind: 'profile'; error: string }
  | { kind: 'transport'; error: string };

export function connectionProbeInvalidation(
  started: ConnectionProbeIdentity,
  current: ConnectionProbeIdentity,
  attemptIsCurrent: boolean,
): ConnectionProbeInvalidation | null {
  if (!hasStableConnectionProbeIdentity(started, current)) {
    return {
      kind: 'profile',
      error: 'Gateway profile changed while testing.',
    };
  }
  if (!attemptIsCurrent) {
    return {
      kind: 'attempt',
      error: 'A newer gateway test superseded this one.',
    };
  }
  if (started.connectionGeneration !== current.connectionGeneration) {
    return {
      kind: 'transport',
      error: 'Gateway transport changed while testing.',
    };
  }
  return null;
}
