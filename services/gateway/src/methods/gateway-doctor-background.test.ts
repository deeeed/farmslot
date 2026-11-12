import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BackgroundHostStatus } from '../host-services/background/client.js';

await import('../runtime/mock-pty.test-support.js');
const { backgroundHostCheck } = await import('./gateway-doctor.js');

const base: BackgroundHostStatus = {
  state: 'ready',
  since: '2026-11-11T10:00:00.000Z',
  pid: 4242,
  restarts: 0,
  rssBytes: 120 * 1_048_576,
  failures: {},
  exec: {},
};

test('a down background process fails the check and names the stale fleet', () => {
  const check = backgroundHostCheck({
    ...base,
    state: 'restarting',
    restarts: 3,
    lastExit: { code: 1, signal: null, at: '2026-11-11T10:00:00.000Z' },
  });
  assert.equal(check.ok, false);
  assert.match(check.detail, /down since 2026-11-11T10:00:00.000Z \(exit code 1, signal null\)/);
  assert.match(check.detail, /fleet stays stale/);
  assert.match(check.hint ?? '', /FARMSLOT_GATEWAY_BACKGROUND=0/);
});

test('a running process passes and warns only on failures since it started', () => {
  assert.deepEqual(backgroundHostCheck(base), {
    id: 'background-host',
    label: 'Background process',
    ok: true,
    detail: 'running (pid 4242, 120 MB, 0 restart(s))',
  });
  const failures: BackgroundHostStatus['failures'] = {
    'fleet.probeMachine': { count: 1, message: 'deadline missed', at: '2026-11-11T10:05:00.000Z' },
    'decisions.scan': { count: 1, message: 'before the restart', at: '2026-11-11T09:00:00.000Z' },
  };
  const check = backgroundHostCheck({ ...base, failures });
  assert.equal(check.warn, true);
  assert.equal(
    check.detail,
    'running (pid 4242, 120 MB, 0 restart(s)); failed: fleet.probeMachine: deadline missed',
  );
});

test('a disabled process warns that probes run on the request loop', () => {
  const check = backgroundHostCheck({ ...base, state: 'disabled' });
  assert.equal(check.ok, true);
  assert.equal(check.warn, true);
  assert.match(check.detail, /run on the request loop/);
});
