import assert from 'node:assert/strict';
import test from 'node:test';

import {
  measureClientRequest,
  performanceBudgetVerdicts,
  PerformanceRecorder,
  renderPrometheus,
} from '../../src/performance/index.js';

const method = 'test.newly-registered';
const registered = new Set([method]);
test('the shared wrapper measures a new registered method and preserves its result and errors', async () => {
  let clock = 0;
  const metrics = new PerformanceRecorder('command-center', {
    clock: () => clock,
    methods: registered,
  });
  const payload = { value: 'observed' };
  assert.equal(
    await measureClientRequest(metrics, method, 'interactive-read', async (received) => {
      clock = 0.02;
      received(123);
      return payload;
    }),
    payload,
  );
  const failure = new Error('original failure');
  await assert.rejects(
    measureClientRequest(metrics, method, 'interactive-read', async () => {
      clock = 0.04;
      throw failure;
    }),
    (error) => error === failure,
  );
  const snapshot = metrics.snapshot();
  const latency = snapshot.histograms.find((item) => item.name === 'farmslot_rpc_duration_seconds');
  assert.equal(latency?.count, 2);
  assert.equal(latency?.sum, 0.04);
  assert.equal(
    snapshot.histograms.find((item) => item.name === 'farmslot_rpc_response_bytes')?.sum,
    123,
  );
  assert.equal(
    snapshot.counters.find((item) => item.name === 'farmslot_rpc_errors_total')?.value,
    1,
  );
});
test('budget verdicts use exact threshold buckets and require coverage', () => {
  const metrics = new PerformanceRecorder('command-center', { methods: registered });
  for (let i = 0; i < 18; i++)
    metrics.observe(
      'farmslot_client_cached_paint_seconds',
      { method, action_class: 'cached-paint' },
      0.099,
    );
  metrics.observe(
    'farmslot_client_cached_paint_seconds',
    { method, action_class: 'cached-paint' },
    0.10001,
  );
  assert.equal(performanceBudgetVerdicts(metrics.snapshot())[0]?.status, 'unmeasured');
  metrics.observe(
    'farmslot_client_cached_paint_seconds',
    { method, action_class: 'cached-paint' },
    0.10001,
  );
  assert.equal(performanceBudgetVerdicts(metrics.snapshot())[0]?.status, 'fail');
});
test('Prometheus output has cumulative buckets and bounded unknown-method labels', () => {
  const metrics = new PerformanceRecorder('gateway', { methods: registered });
  for (let i = 0; i < 1000; i++)
    metrics.observe('farmslot_rpc_duration_seconds', { method: `unknown-${i}` }, 0.02);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.histograms.length, 1);
  const text = renderPrometheus(snapshot);
  assert.match(text, /# TYPE farmslot_rpc_duration_seconds histogram/);
  assert.match(text, /le="\+Inf".* 1000/);
  assert.match(text, /farmslot_rpc_duration_seconds_count.* 1000/);
  assert.doesNotMatch(text, /unknown-999/);
});
test('client deltas are idempotent and observations during an in-flight report are retained', () => {
  const client = new PerformanceRecorder('companion', { methods: registered });
  const gateway = new PerformanceRecorder('gateway', { methods: registered });
  client.observe('farmslot_rpc_duration_seconds', { method }, 0.1);
  const first = client.beginReport();
  assert.ok(first);
  client.observe('farmslot_rpc_duration_seconds', { method }, 0.2);
  assert.equal(gateway.mergeReport('authenticated-client', first).accepted, true);
  assert.equal(gateway.mergeReport('authenticated-client', first).duplicate, true);
  client.acknowledge(first.sequence);
  const second = client.beginReport();
  assert.ok(second);
  gateway.mergeReport('authenticated-client', second);
  const latency = gateway
    .snapshot()
    .histograms.find((item) => item.name === 'farmslot_rpc_duration_seconds');
  assert.equal(latency?.count, 2);
  assert.ok(Math.abs((latency?.sum ?? 0) - 0.3) < 0.00001);
  assert.equal(latency?.max, 0.2);
});
test('reread rates expire old bins even when the query becomes idle', () => {
  let clock = 0;
  const metrics = new PerformanceRecorder('command-center', {
    clock: () => clock,
    methods: registered,
  });
  const query = { privateKey: 'private-query-key' };
  metrics.reread(method, query);
  clock = 59;
  metrics.reread(method, query);
  clock = 100;
  assert.equal(metrics.snapshot().gauges[0]?.value, 1);
  assert.doesNotMatch(renderPrometheus(metrics.snapshot()), /private-query-key/);
});
test('a bounded delta chunk includes counters during a histogram burst', () => {
  const names = new Set(Array.from({ length: 140 }, (_, i) => `test.method-${i}`));
  const metrics = new PerformanceRecorder('companion', { methods: names });
  for (const name of names) {
    metrics.observe('farmslot_rpc_duration_seconds', { method: name }, 0.1);
    metrics.increment('farmslot_rpc_errors_total', { method: name });
  }
  const report = metrics.beginReport();
  assert.ok(report);
  assert.ok(report.histograms.length > 0);
  assert.ok(report.counters.length > 0);
  assert.ok(report.histograms.length + report.counters.length <= 128);
});

test('an account change fences a request already in flight', async () => {
  const metrics = new PerformanceRecorder('companion', { methods: registered });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = measureClientRequest(metrics, method, 'interactive-read', async (received) => {
    await held;
    received(30);
    return 7;
  });
  metrics.resetScope();
  release();
  assert.equal(await pending, 7);
  assert.equal(metrics.snapshot().histograms.length, 0);
});
test('client report validation refuses malformed metric names, labels and counts', async () => {
  const { isClientPerformanceReport } = await import('../../src/performance/index.js');
  const client = new PerformanceRecorder('companion', { methods: registered });
  client.observe('farmslot_rpc_duration_seconds', { method }, 0.01);
  const report = client.beginReport();
  assert.ok(report);
  assert(isClientPerformanceReport(report));
  assert.equal(
    isClientPerformanceReport({
      ...report,
      histograms: [{ ...report.histograms[0], name: 'private_metric' }],
    }),
    false,
  );
  assert.equal(
    isClientPerformanceReport({
      ...report,
      histograms: [{ ...report.histograms[0], labels: { private: 'payload' } }],
    }),
    false,
  );
  assert.equal(
    isClientPerformanceReport({ ...report, histograms: [{ ...report.histograms[0], count: -1 }] }),
    false,
  );
});

test('cache-only observations schedule a batched report without any network request finishing', async (t) => {
  const { PerformanceReporter } = await import('../../src/performance/index.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const metrics = new PerformanceRecorder('companion');
  let sent = 0;
  const reporter = new PerformanceReporter(
    metrics,
    () => true,
    async () => {
      sent++;
      return { accepted: true };
    },
  );
  try {
    metrics.observe(
      'farmslot_client_cached_paint_seconds',
      { method: 'run.get', action_class: 'cached-paint' },
      0.02,
    );
    assert.equal(sent, 0);
    t.mock.timers.tick(30000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent, 1);
  } finally {
    reporter.dispose();
  }
});

test('Doctor ranks cached paint separately from RPC bytes and marks absent process samples', async () => {
  const { slowestActions } = await import('../../src/performance/index.js');
  const metrics = new PerformanceRecorder('companion');
  for (let i = 0; i < 20; i++)
    metrics.observe(
      'farmslot_client_cached_paint_seconds',
      { method: 'run.get', action_class: 'cached-paint', cache_source: 'stored' },
      0.12,
    );
  const [row] = slowestActions(metrics.snapshot());
  assert.equal(row.phase, 'Cached paint');
  assert.equal(row.budgetStatus, 'fail');
  assert.equal(row.bytesMeasured, false);
  assert.equal(row.processesMeasured, false);
});

test('reported observation windows use opaque source ids and preserve client timestamps', () => {
  const client = new PerformanceRecorder('companion');
  const gateway = new PerformanceRecorder('gateway');
  client.observe('farmslot_client_cached_paint_seconds', { method: 'run.get' }, 0.01);
  const report = client.beginReport();
  assert.ok(report);
  gateway.mergeReport('private-principal', report);
  assert.equal(gateway.snapshot().clientWindows?.[0].startedAtMs, report.startedAtMs);
  const output = renderPrometheus(gateway.snapshot());
  assert.match(output, /farmslot_client_window_observed_seconds/);
  assert.doesNotMatch(output, /private-principal/);
});
