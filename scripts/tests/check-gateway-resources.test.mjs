import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { checkGatewayResources } from '../check-gateway-resources.mjs';

function fixture({ count = 76, rssKiB = 900 * 1024, changed = false } = {}) {
  let snapshots = 0;
  return (command, args) => {
    if (command === 'ps') {
      assert.deepEqual(args, ['-p', '123', '-o', 'lstart=', '-o', 'rss=']);
      return `Thu Oct ${changed && snapshots++ ? '16' : '15'} 12:00:00 2026 ${rssKiB}\n`;
    }
    assert.equal(command, 'lsof');
    if (args.includes('-t')) {
      assert.deepEqual(args, ['-nP', '-t', '-iTCP:7801', '-sTCP:LISTEN']);
      return '123\n123\n';
    }
    assert.deepEqual(args, ['-nP', '-a', '-p', '123', '-Ff']);
    return `p123\nfcwd\nftxt\n${Array.from({ length: count }, (_, i) => `f${i}`).join('\n')}\n`;
  };
}

test('heartbeat resolves the listener and reports numeric FDs and RSS without file paths', () => {
  const result = checkGatewayResources({ port: 7801 }, fixture());
  assert.deepEqual(result, {
    ok: true,
    pid: 123,
    fds: 76,
    rssMiB: 900,
    maxFds: 2048,
    maxRssMiB: 4096,
  });
});

test('alerts on the reported FD leak and independently on excessive RSS', () => {
  assert.equal(checkGatewayResources({ pid: 123 }, fixture({ count: 44342 })).ok, false);
  assert.equal(checkGatewayResources({ pid: 123 }, fixture({ rssKiB: 7 * 1024 * 1024 })).ok, false);
  assert.equal(checkGatewayResources({ pid: 123, maxFds: 75 }, fixture()).ok, false);
});

test('refuses unavailable probes, malformed metadata and PID reuse without a healthy claim', () => {
  assert.throws(
    () =>
      checkGatewayResources({ pid: 123 }, () => {
        throw new Error('probe timeout');
      }),
    /probe timeout/,
  );
  assert.throws(() => checkGatewayResources({ pid: 123 }, () => ''), /unavailable/);
  assert.throws(() => checkGatewayResources({ pid: 123 }, fixture({ count: 0 })), /unavailable/);
  assert.throws(
    () => checkGatewayResources({ pid: 123 }, fixture({ changed: true })),
    /PID changed/,
  );
  assert.throws(
    () => checkGatewayResources({ pid: '123; echo secret' }, fixture()),
    /positive integer/,
  );
});

test(
  'standalone guard measures a real process and returns nonzero for a breached budget',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  () => {
    const script = new URL('../check-gateway-resources.mjs', import.meta.url);
    const run = (extra) =>
      execFileSync(process.execPath, [script.pathname, '--pid', String(process.pid), ...extra], {
        encoding: 'utf8',
        timeout: 4900,
        stdio: 'pipe',
      });
    assert.match(run([]), /gateway-resources OK/);
    assert.throws(
      () => run(['--max-fds', '1']),
      (error) => error.status === 1 && /gateway-resources ALERT/.test(error.stdout),
    );
  },
);
