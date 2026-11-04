import assert from 'node:assert/strict';
import test from 'node:test';

import { PerformanceRecorder } from '@farmslot/protocol/performance';

import {
  measureGatewayRequest,
  measureManagedOperation,
  recordGatewayResponse,
} from './performance.js';

test('new methods inherit dispatch, response bytes and concurrent process attribution', async () => {
  const method = 'new.registered.method';
  const metrics = new PerformanceRecorder('gateway', { methods: new Set([method]) });
  const result = await measureGatewayRequest(
    method,
    async () => {
      await Promise.all([
        measureManagedOperation('exec', 'git', async () => 42),
        measureManagedOperation('node', 'node', async () => 43),
      ]);
      recordGatewayResponse(123, true);
      return 17;
    },
    metrics,
  );
  assert.equal(result, 17);
  const s = metrics.snapshot();
  assert.equal(s.histograms.find((r) => r.name === 'farmslot_rpc_duration_seconds')?.count, 1);
  assert.equal(s.histograms.find((r) => r.name === 'farmslot_rpc_response_bytes')?.sum, 123);
  assert.equal(s.counters.find((r) => r.name === 'farmslot_exec_calls_total')?.value, 1);
  assert.equal(s.counters.find((r) => r.name === 'farmslot_node_calls_total')?.value, 1);
  assert.ok(s.counters.every((r) => r.labels.method === method));
});
test('dispatch preserves failures and isolates concurrent methods', async () => {
  const metrics = new PerformanceRecorder('gateway', { methods: new Set(['one', 'two']) });
  const error = new Error('original');
  await Promise.all([
    assert.rejects(
      measureGatewayRequest(
        'one',
        async () => {
          await measureManagedOperation('exec', 'git', async () => 0);
          throw error;
        },
        metrics,
      ),
      (e) => e === error,
    ),
    measureGatewayRequest(
      'two',
      async () => {
        recordGatewayResponse(64, true);
      },
      metrics,
    ),
  ]);
  assert.equal(
    metrics.snapshot().counters.find((r) => r.name === 'farmslot_rpc_errors_total')?.labels.method,
    'one',
  );
  assert.equal(
    metrics.snapshot().counters.find((r) => r.name === 'farmslot_exec_calls_total')?.labels.method,
    'one',
  );
});

test('detached execution and node wait remain outside a completed request costs', async () => {
  const metrics = new PerformanceRecorder('gateway', { methods: new Set(['foreground']) });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const detached: Promise<void>[] = [];
  await measureGatewayRequest(
    'foreground',
    async () => {
      detached.push(measureManagedOperation('exec', 'git', () => gate));
      detached.push(measureManagedOperation('wait', 'node', () => gate));
    },
    metrics,
  );
  release();
  await Promise.all(detached);
  const rows = metrics.snapshot().counters;
  assert.equal(
    rows.find((row) => row.name === 'farmslot_exec_seconds_total')?.labels.method,
    '_background',
  );
  assert.equal(
    rows.find((row) => row.name === 'farmslot_node_wait_seconds_total')?.labels.method,
    '_background',
  );
});
