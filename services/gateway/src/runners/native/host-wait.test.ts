import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { nativeHostUnavailableError } from '@farmslot/agent-runtime/native/host-unavailable';
import { Methods } from '@farmslot/protocol';

const node = await import('./node.js');
const calls: Array<{ method: string; executionNodeId: unknown }> = [];
/** Each queued reply is one probe: an error for a host that never answered, or ready. */
let replies: Array<Error | 'ready'> = [];
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (
      _owner: string,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      calls.push({ method, executionNodeId: params?.executionNodeId });
      const reply = replies.shift() ?? 'ready';
      if (reply !== 'ready') throw reply;
      return { sessions: [] };
    },
  },
});
const { NATIVE_HOST_WAIT_MS, waitForNativeHostReady } = await import('./host-wait.js');
const unavailable = () => nativeHostUnavailableError('/root/host.log');
let clock = 0;
const slept: number[] = [];
const wait = (extra: Partial<Parameters<typeof waitForNativeHostReady>[0]> = {}) =>
  waitForNativeHostReady({
    owner: 'owner',
    executionNodeId: 'macpro',
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    ...extra,
  });
beforeEach(() => {
  calls.length = 0;
  slept.length = 0;
  replies = [];
  clock = 0;
});

test('a host that comes back during the wait is launched on, not refused', async () => {
  replies = [unavailable(), unavailable(), 'ready'];
  const result = await wait();
  assert.equal(result.probes, 3);
  assert.equal(result.waitedMs, 2_000, 'the two sleeps between probes');
  assert.deepEqual(
    calls.map((call) => call.method),
    [Methods.NATIVE_SESSION_LIST, Methods.NATIVE_SESSION_LIST, Methods.NATIVE_SESSION_LIST],
  );
  assert.equal(calls[0].executionNodeId, 'macpro', 'the probe reads the node that is restarting');
});

test('a host that never comes back refuses with the wait named', async () => {
  replies = Array.from({ length: 200 }, unavailable);
  await assert.rejects(wait(), (error: Error) => {
    assert.match(error.message, /No command was retried\./, 'the original refusal is kept');
    assert.match(error.message, /host on macpro stayed unavailable: waited 120 s of 120 s/);
    return true;
  });
  assert.equal(clock, NATIVE_HOST_WAIT_MS, 'the wait is bounded by its own ceiling');
});

test('a budget shorter than the ceiling bounds the wait and names its own length', async () => {
  replies = Array.from({ length: 200 }, unavailable);
  await assert.rejects(wait({ budgetMs: 10_000 }), /stayed unavailable: waited 10 s of 10 s/);
  assert.equal(clock, 10_000);
  assert.equal(slept.length, 10, 'one probe a second inside the budget');
});

test('no budget left refuses after one probe and says it did not wait', async () => {
  replies = Array.from({ length: 200 }, unavailable);
  await assert.rejects(
    wait({ budgetMs: 0 }),
    /stayed unavailable: the step had no budget left to wait for it/,
  );
  assert.equal(calls.length, 1, 'the host is still asked once');
  assert.deepEqual(slept, [], 'and nothing is spent waiting');
});

test('a failure other than a host that never answered is not waited out', async () => {
  const transport = Object.assign(
    new Error('Native execution node is unavailable for this owner'),
    {
      code: 'NATIVE_SESSION_ERROR',
    },
  );
  replies = [transport];
  await assert.rejects(wait(), /unavailable for this owner/);
  assert.equal(calls.length, 1);
  assert.deepEqual(slept, []);
});

test('work that is gone ends the wait instead of holding its slot', async () => {
  replies = [unavailable(), unavailable(), 'ready'];
  let probes = 0;
  await assert.rejects(
    wait({
      assertCurrent: async () => {
        if (probes++ === 1) throw new Error('Native worker slot ownership changed');
      },
    }),
    /slot ownership changed/,
  );
  assert.equal(calls.length, 1, 'the wait stops before probing again');
  assert.equal(clock, 1_000, 'and it spends nothing more');
});
