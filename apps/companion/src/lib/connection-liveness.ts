import type { ConnectionState } from './gateway-client';

export type ConnectionHealthState =
  | 'connecting'
  | 'socket-up-not-proven'
  | 'healthy'
  | 'degraded'
  | 'disconnected';

export interface ConnectionLiveness {
  status: ConnectionHealthState;
  lastSuccessAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export const INITIAL_CONNECTION_LIVENESS: ConnectionLiveness = {
  status: 'disconnected',
  lastSuccessAt: null,
  lastLatencyMs: null,
  lastError: null,
  consecutiveFailures: 0,
};

export function livenessForTransportState(
  current: ConnectionLiveness,
  transportState: ConnectionState,
): ConnectionLiveness {
  if (transportState === 'connecting') {
    return { ...current, status: 'connecting' };
  }
  if (transportState === 'connected') {
    return {
      ...current,
      status: 'socket-up-not-proven',
      lastError: null,
    };
  }
  return { ...current, status: 'disconnected' };
}

export function livenessAfterSuccess(
  current: ConnectionLiveness,
  completedAt: number,
  latencyMs: number,
): ConnectionLiveness {
  return {
    ...current,
    status: 'healthy',
    lastSuccessAt: completedAt,
    lastLatencyMs: latencyMs,
    lastError: null,
    consecutiveFailures: 0,
  };
}

export function livenessAfterFailure(
  current: ConnectionLiveness,
  transportState: ConnectionState,
  error: unknown,
): ConnectionLiveness {
  return {
    ...current,
    status: transportState === 'connected' ? 'degraded' : 'disconnected',
    lastError: connectionProbeTeachingError(error),
    consecutiveFailures: current.consecutiveFailures + 1,
  };
}

export function connectionProbeTeachingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes('socket') ||
    normalized.includes('network') ||
    normalized.includes('not connected') ||
    normalized.includes('connection closed') ||
    normalized.includes('gateway closed') ||
    normalized.includes('did not connect') ||
    normalized.includes('unreachable')
  ) {
    return 'Gateway is unreachable. Check the profile host and port, network, and gateway bind address.';
  }
  if (
    normalized.includes('auth') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('credential') ||
    normalized.includes('token') ||
    normalized.includes('password')
  ) {
    return 'Authentication failed. Check this profile’s credential or pair it again.';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'Gateway timed out. Check the host and confirm LAN or Tailscale is connected.';
  }
  return `Gateway did not answer: ${message}`;
}

export function nextConnectionProbeDelay(
  consecutiveFailures: number,
  healthyIntervalMs = 30_000,
  maximumIntervalMs = 120_000,
): number {
  if (consecutiveFailures <= 0) return healthyIntervalMs;
  return Math.min(healthyIntervalMs * 2 ** consecutiveFailures, maximumIntervalMs);
}

export function formatLastGatewayResponse(lastSuccessAt: number | null, now = Date.now()): string {
  if (lastSuccessAt === null) return 'Never proven';
  const elapsedSeconds = Math.max(0, Math.floor((now - lastSuccessAt) / 1000));
  if (elapsedSeconds < 5) return 'Just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  return new Date(lastSuccessAt).toLocaleString();
}

export function connectionHealthLabel(status: ConnectionHealthState): string {
  if (status === 'socket-up-not-proven') return 'Socket connected · proving';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function connectionHealthCanRetry(status: ConnectionHealthState): boolean {
  return status === 'disconnected' || status === 'degraded';
}
