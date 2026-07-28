import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectionHealthCanRetry,
  connectionHealthLabel,
  connectionProbeTeachingError,
  formatLastGatewayResponse,
  INITIAL_CONNECTION_LIVENESS,
  livenessAfterFailure,
  livenessAfterSuccess,
  livenessForTransportState,
  nextConnectionProbeDelay,
} from './connection-liveness';

test('transport connection remains unproven until an authenticated probe succeeds', () => {
  const socketUp = livenessForTransportState(INITIAL_CONNECTION_LIVENESS, 'connected');
  assert.equal(socketUp.status, 'socket-up-not-proven');

  const healthy = livenessAfterSuccess(socketUp, 2_000, 42);
  assert.deepEqual(healthy, {
    status: 'healthy',
    lastSuccessAt: 2_000,
    lastLatencyMs: 42,
    lastError: null,
    consecutiveFailures: 0,
  });
});

test('a failed probe removes healthy state without erasing the last success', () => {
  const healthy = livenessAfterSuccess(INITIAL_CONNECTION_LIVENESS, 2_000, 42);
  const degraded = livenessAfterFailure(healthy, 'connected', new Error('request timed out'));
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.lastSuccessAt, 2_000);
  assert.match(degraded.lastError ?? '', /host.*LAN or Tailscale/i);

  const disconnected = livenessForTransportState(degraded, 'disconnected');
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(disconnected.lastSuccessAt, 2_000);
});

test('probe errors teach auth, timeout, and host recovery', () => {
  assert.match(connectionProbeTeachingError(new Error('Unauthorized')), /credential/i);
  assert.match(connectionProbeTeachingError(new Error('Request timed out')), /Tailscale/i);
  assert.match(connectionProbeTeachingError(new Error('Socket closed')), /bind address/i);
  assert.match(
    connectionProbeTeachingError(new Error('Gateway closed before authenticated status completed')),
    /unreachable/i,
  );
});

test('probe interval backs off after failures and response time is readable', () => {
  assert.equal(nextConnectionProbeDelay(0), 30_000);
  assert.equal(nextConnectionProbeDelay(1), 60_000);
  assert.equal(nextConnectionProbeDelay(2), 120_000);
  assert.equal(nextConnectionProbeDelay(8), 120_000);
  assert.equal(formatLastGatewayResponse(null, 10_000), 'Never proven');
  assert.equal(formatLastGatewayResponse(5_000, 10_000), '5s ago');
  assert.equal(connectionHealthLabel('socket-up-not-proven'), 'Socket connected · proving');
  assert.equal(connectionHealthLabel('healthy'), 'Healthy');
});

test('manual retry is limited to actionable connection failures', () => {
  assert.equal(connectionHealthCanRetry('disconnected'), true);
  assert.equal(connectionHealthCanRetry('degraded'), true);
  assert.equal(connectionHealthCanRetry('healthy'), false);
  assert.equal(connectionHealthCanRetry('connecting'), false);
  assert.equal(connectionHealthCanRetry('socket-up-not-proven'), false);
});
