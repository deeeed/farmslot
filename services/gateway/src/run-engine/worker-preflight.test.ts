import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type LaunchPreflightOptions,
  LaunchPreflightRefusal,
  type LaunchProbe,
  type LaunchProbeName,
  type LaunchProbeResult,
  runLaunchPreflight,
} from './worker-preflight.js';

function fixture() {
  let time = 0;
  const records: Array<{
    name: LaunchProbeName;
    result: LaunchProbeResult;
    attempts: number;
    elapsed: number;
  }> = [];
  const waits: number[] = [];
  const options: LaunchPreflightOptions = {
    timing: {
      code: { budgetMs: 12_000, retryWaitMs: 5_609 },
      toolchain: { budgetMs: 16_000, retryWaitMs: 7_841 },
      leftovers: { budgetMs: 41_000, retryWaitMs: 20_245 },
    },
    assertCurrent: () => {},
    record: (name, result, attempts, elapsed) => records.push({ name, result, attempts, elapsed }),
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    deadline: (_ms, expire) => {
      const handle = setImmediate(expire);
      return () => clearImmediate(handle);
    },
  };
  return { records, waits, options };
}

for (const name of ['code', 'toolchain', 'leftovers'] as const) {
  test(`${name} observed mismatch refuses without starting a worker or retrying`, async () => {
    const f = fixture();
    let launches = 0;
    await assert.rejects(
      async () => {
        await runLaunchPreflight(
          [
            {
              name,
              inspect: async () => ({
                status: 'mismatch',
                detail: 'observed wrong input; use its supported owner',
              }),
            },
          ],
          f.options,
        );
        launches++;
      },
      (error: unknown) => error instanceof LaunchPreflightRefusal && error.probe === name,
    );
    assert.equal(launches, 0);
    assert.deepEqual(f.waits, []);
    assert.equal(f.records[0].attempts, 1);
  });
}

test('a timed-out observation waits and retries with its full individual budget', async () => {
  const f = fixture();
  const budgets: number[] = [];
  let firstSignal: AbortSignal | undefined;
  const probe: LaunchProbe = {
    name: 'code',
    inspect: (signal, budget) => {
      budgets.push(budget);
      if (budgets.length === 1) {
        firstSignal = signal;
        return new Promise(() => {});
      }
      return Promise.resolve({ status: 'verified', detail: 'pinned bytes match' });
    },
  };
  await runLaunchPreflight([probe], f.options);
  assert.deepEqual(budgets, [12_000, 12_000]);
  assert.equal(firstSignal?.aborted, true);
  assert.deepEqual(f.waits, [5_609]);
  assert.equal(f.records.at(-1)?.result.status, 'verified');
  assert.equal(f.records.at(-1)?.attempts, 2);
});

test('two timeouts permit launch with explicit unverified details, never a pass', async () => {
  const f = fixture();
  let launched = false;
  await runLaunchPreflight(
    [{ name: 'toolchain', inspect: () => new Promise(() => {}) }],
    f.options,
  );
  launched = true;
  assert.equal(launched, true);
  assert.equal(f.records.at(-1)?.result.status, 'unverified');
  assert.equal(f.records.at(-1)?.attempts, 2);
  assert.match(f.records.at(-1)?.result.detail ?? '', /16000ms/);
  assert.deepEqual(f.waits, [7_841]);
});

test('transport unavailability is retried and remains recorded as unverified', async () => {
  const f = fixture();
  await runLaunchPreflight(
    [
      {
        name: 'leftovers',
        inspect: async () => {
          throw new Error('node unavailable');
        },
      },
    ],
    f.options,
  );
  assert.equal(f.records.at(-1)?.result.status, 'unverified');
  assert.match(f.records.at(-1)?.result.detail ?? '', /node unavailable/);
  assert.deepEqual(f.waits, [20_245]);
});

test('a stable absent declaration stays unverified without a pointless retry', async () => {
  const f = fixture();
  let reads = 0;
  await runLaunchPreflight(
    [
      {
        name: 'code',
        inspect: async () => {
          reads++;
          return { status: 'unverified', detail: 'No retained source receipt', retry: false };
        },
      },
    ],
    f.options,
  );
  assert.equal(reads, 1);
  assert.deepEqual(f.waits, []);
  assert.equal(f.records[0].result.status, 'unverified');
  assert.equal(f.records[0].attempts, 1);
});

test('generation change while a probe runs refuses before recording or launching', async () => {
  const f = fixture();
  let generation = 3;
  f.options.assertCurrent = () => {
    if (generation !== 3) throw new Error('generation changed');
  };
  await assert.rejects(
    runLaunchPreflight(
      [
        {
          name: 'code',
          inspect: async () => {
            generation++;
            return { status: 'verified', detail: 'read completed after cancellation' };
          },
        },
      ],
      f.options,
    ),
    /generation changed/,
  );
  assert.equal(f.records.length, 0);
});

test('cancellation during the retry wait never spends a new probe or launches', async () => {
  const f = fixture();
  let cancelled = false;
  let inspections = 0;
  f.options.wait = async () => {
    cancelled = true;
  };
  f.options.assertCurrent = () => {
    if (cancelled) throw new Error('cancelled');
  };
  await assert.rejects(
    runLaunchPreflight(
      [
        {
          name: 'code',
          inspect: async () => {
            inspections++;
            return { status: 'unverified', detail: 'slow transport' };
          },
        },
      ],
      f.options,
    ),
    /cancelled/,
  );
  assert.equal(inspections, 1);
});

test('each probe receives its measured budget without a total ten-second cutoff', async () => {
  const f = fixture();
  const budgets: number[] = [];
  const probes: LaunchProbe[] = (['code', 'toolchain', 'leftovers'] as const).map((name) => ({
    name,
    inspect: async (_signal, budget) => {
      budgets.push(budget);
      return { status: 'verified', detail: 'observed' };
    },
  }));
  await runLaunchPreflight(probes, f.options);
  assert.deepEqual(budgets, [12_000, 16_000, 41_000]);
  assert.deepEqual(f.waits, []);
});
