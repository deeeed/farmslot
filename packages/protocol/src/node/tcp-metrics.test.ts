import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectTcpMetrics, parseTcpMetrics } from './tcp-metrics.js';

test('macOS counts TCP states and ranks owners using the netstat header', () => {
  const sample = parseTcpMetrics(
    'darwin',
    '40000\n40009\n',
    `
Active Internet connections (including servers)
Proto Recv-Q Send-Q Local Address Foreign Address (state) rhiwat shiwat pid epid state options
 tcp4 0 0 local.40001 peer.443 ESTABLISHED 0 0 101 0 0 0
 tcp6 0 0 local.40002 peer.443 ESTABLISHED 0 0 101 0 0 0
 tcp4 0 0 local.40003 peer.443 TIME_WAIT 0 0 0 0 0 0
 tcp4 0 0 local.40004 peer.443 ESTABLISHED 0 0 202 0 0 0
 tcp4 0 0 local.40005 peer.443 TIME_WAIT 0 0 0 0 0 0
 tcp4 0 0 local.8080 *.* LISTEN 0 0 303 0 0 0
`,
    '101 server\n202 helper\n303 listener',
  );
  assert.equal(sample.established, 3);
  assert.equal(sample.timeWait, 2);
  assert.equal(sample.total, 5);
  assert.equal(sample.ephemeralCapacity, 10);
  assert.equal(sample.warningThreshold, 5);
  assert.equal(sample.criticalThreshold, 8);
  assert.equal(sample.severity, 'warning');
  assert.deepEqual(sample.topProcesses, [
    { pid: 101, command: 'server', connections: 2 },
    { pid: 202, command: 'helper', connections: 1 },
  ]);
});

test('Linux ss includes unowned TIME_WAIT and each socket once despite shared descriptors', () => {
  const sample = parseTcpMetrics(
    'linux',
    '40000 40004',
    `
ESTAB 0 0 local:40000 peer:443 users:(("server",pid=101,fd=1),("server",pid=101,fd=2))
TIME-WAIT 0 0 local:40001 peer:443
ESTAB 0 0 local:40002 peer:443 users:(("helper",pid=202,fd=3))
TIME-WAIT 0 0 local:40003 peer:443
LISTEN 0 0 local:8080 *:*
`,
  );
  assert.equal(sample.total, 4);
  assert.equal(sample.severity, 'critical');
  assert.equal(sample.warningThreshold, 3);
  assert.equal(sample.criticalThreshold, 4);
  assert.equal(sample.topProcesses[0].connections, 1);
});

test('invalid range or unreadable socket table never reports healthy zero', () => {
  assert.throws(() => parseTcpMetrics('linux', 'bad', ''));
  assert.throws(() => parseTcpMetrics('linux', '40000 50000', 'permission denied'));
  assert.throws(() => parseTcpMetrics('darwin', '50000 40000', ''));
  assert.throws(() => parseTcpMetrics('darwin', '40000 50000', 'permission denied'));
});

test('collector bounds commands, caches for a minute, and coalesces concurrent samples', async () => {
  const calls: string[] = [];
  const runner = async (command: string, args: readonly string[]) => {
    calls.push([command, ...args].join(' '));
    if (command === 'cat') return '40000 50000';
    return 'ESTAB 0 0 local:40001 peer:443 users:(("server",pid=101,fd=1))';
  };
  const [first, second] = await Promise.all([
    collectTcpMetrics('linux', runner, 1000),
    collectTcpMetrics('linux', runner, 1000),
  ]);
  assert.deepEqual(first, second);
  await collectTcpMetrics('linux', runner, 1001);
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((call) => call.includes('lsof')),
    false,
  );
});

test('failed TCP commands report unknown health rather than zero connections', async () => {
  const metrics = await collectTcpMetrics(
    'linux',
    async () => {
      throw new Error('fixture timeout');
    },
    120000,
  );
  assert.equal(metrics.severity, 'unknown');
  if (metrics.severity === 'unknown') assert.match(metrics.error, /fixture timeout/);
});
