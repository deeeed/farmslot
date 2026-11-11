import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ModelCatalogNode,
  nodeModelCatalogs,
  type RunnerModelCatalogNodeSource,
} from './model-catalog.js';
import { RunnerModelCatalogObservation } from './model-catalog-observation.js';
import { getRunnerDefinition } from './registry.js';

const source: RunnerModelCatalogNodeSource = {
  nodeCommand: 'fixture-pi',
  slotPathKey: 'piPath',
  args: ['--list-models'],
  parse: (output) => output.split('\n').filter(Boolean),
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const managed = { legacyInterest: false };

class RetryClock {
  now = 1000;
  readonly timers = new Map<() => void, number>();
  readonly delays: number[] = [];

  schedule = (callback: () => void, delay: number): (() => void) => {
    this.delays.push(delay);
    this.timers.set(callback, this.now + delay);
    return () => this.timers.delete(callback);
  };

  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const [callback, at] of this.timers) {
      if (at > this.now) continue;
      this.timers.delete(callback);
      callback();
    }
    await settle();
  }
}

function fixture(
  runner: string,
  nodes: ModelCatalogNode[],
  catalogSource: RunnerModelCatalogNodeSource = source,
) {
  const clock = new RetryClock();
  let changes = 0;
  let interested = false;
  const observation = new RunnerModelCatalogObservation({
    runners: () => [runner],
    select: async () => catalogSource,
    nodes: async () => nodes,
    hasInterest: () => interested,
    changed: () => changes++,
    now: () => clock.now,
    scheduleRetry: clock.schedule,
  });
  return {
    observation,
    clock,
    changes: () => changes,
    interest: () => {
      interested = true;
    },
  };
}

test('failed node retries with capped backoff without picker interest; healthy node stays untouched', async (t) => {
  const runner = 'retry-backoff';
  let attempts = 0;
  let healthyAttempts = 0;
  const { observation, clock, changes } = fixture(runner, [
    {
      machine: 'node-a',
      list: async () => {
        if (++attempts <= 8) throw new Error('fixture listing timed out');
        return 'litellm/fixture-model-a';
      },
    },
    {
      machine: 'node-b',
      list: async () => {
        healthyAttempts++;
        return 'litellm/fixture-model-b';
      },
    },
  ]);
  t.after(() => observation.stop());
  nodeModelCatalogs.record(runner, 'node-a', []);
  await observation.read(runner);
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), []);
  const initialChanges = changes();
  for (const delay of [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    assert.equal(clock.delays.at(-1), delay);
    assert.equal(clock.timers.size, 1);
    await clock.advance(delay - 1);
    const before = attempts;
    await clock.advance(1);
    assert.equal(attempts, before + 1);
  }
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), ['litellm/fixture-model-a']);
  assert.equal(healthyAttempts, 1);
  assert.ok(changes() > initialChanges, 'recovery must notify the revision owner');
  assert.deepEqual(
    (await observation.read(runner, managed)).models.map((model) => model.id),
    ['litellm/fixture-model-a', 'litellm/fixture-model-b'],
  );
  assert.equal(clock.timers.size, 0);
  await clock.advance(3_600_000);
  await observation.tick();
  assert.equal(attempts, 9);
});

test('a disconnected node fills after connecting without any further catalog read', async (t) => {
  const runner = 'retry-disconnected';
  let connected = false;
  let attempts = 0;
  const { observation, clock, changes } = fixture(runner, [
    {
      machine: 'node-a',
      list: async () => {
        attempts++;
        if (!connected) throw new Error('node is not connected');
        return 'litellm/fixture-model-a';
      },
    },
  ]);
  t.after(() => observation.stop());
  await observation.read(runner);
  connected = true;
  await clock.advance(15_000);
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), ['litellm/fixture-model-a']);
  assert.equal(changes(), 2);
  await clock.advance(600_000);
  assert.equal(attempts, 2);
});

test('a retry shares in-flight listings with readers and an interested tick', async (t) => {
  const runner = 'retry-concurrent';
  let attempts = 0;
  const completions: Array<(output: string) => void> = [];
  const { observation, clock, interest } = fixture(runner, [
    {
      machine: 'node-a',
      list: async () => {
        if (++attempts === 1) throw new Error('fixture command failed');
        return new Promise<string>((resolve) => {
          completions.push(resolve);
        });
      },
    },
  ]);
  t.after(() => {
    for (const complete of completions) complete('litellm/fixture-model-a');
    return observation.stop();
  });
  await observation.read(runner);
  await clock.advance(15_000);
  assert.equal(attempts, 2, 'the retry must start before a reader requests the catalog');
  interest();
  const reads = [observation.read(runner), observation.read(runner), observation.tick()];
  await clock.advance(600_000);
  assert.equal(attempts, 2);
  for (const complete of completions) complete('litellm/fixture-model-a');
  await Promise.all(reads);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), ['litellm/fixture-model-a']);
});

test('stop cancels queued retries and drains in-flight retries without publishing late results', async () => {
  let attempts = 0;
  const queued = fixture('retry-stopped-queued', [
    {
      machine: 'node-a',
      list: async () => {
        attempts++;
        throw new Error('fixture command failed');
      },
    },
  ]);
  await queued.observation.read('retry-stopped-queued');
  await queued.observation.stop();
  assert.equal(queued.clock.timers.size, 0);
  await queued.clock.advance(600_000);
  assert.equal(attempts, 1);

  const runner = 'retry-stopped-pending';
  let complete!: (output: string) => void;
  const pending = fixture(runner, [
    {
      machine: 'node-a',
      list: async () => {
        if (++attempts === 2) throw new Error('fixture command failed');
        return new Promise<string>((resolve) => {
          complete = resolve;
        });
      },
    },
  ]);
  await pending.observation.read(runner);
  await pending.clock.advance(15_000);
  let drained = false;
  const stopping = pending.observation.stop().then(() => {
    drained = true;
  });
  await settle();
  assert.equal(drained, false);
  complete('litellm/fixture-late-model');
  await stopping;
  assert.equal(pending.changes(), 1);
  assert.equal(nodeModelCatalogs.listing(runner, 'node-a'), undefined);
  await pending.clock.advance(600_000);
  assert.equal(attempts, 3);
});

test('a successful read cancels a queued retry and the next failure restarts backoff', async (t) => {
  const runner = 'retry-successful-read';
  let failing = true;
  let attempts = 0;
  const { observation, clock } = fixture(runner, [
    {
      machine: 'node-a',
      list: async () => {
        attempts++;
        if (failing) throw new Error('fixture command failed');
        return 'litellm/fixture-model-a';
      },
    },
  ]);
  t.after(() => observation.stop());
  await observation.read(runner);
  await clock.advance(15_000);
  assert.deepEqual(clock.delays, [15_000, 30_000]);
  failing = false;
  await observation.read(runner);
  assert.equal(clock.timers.size, 0);
  await clock.advance(30_000);
  assert.equal(attempts, 3);
  failing = true;
  await observation.read(runner);
  assert.equal(clock.delays.at(-1), 15_000);
});

test('failed runner/node pairs retry independently and stop when their source is replaced', async () => {
  const clock = new RetryClock();
  let selected: RunnerModelCatalogNodeSource | undefined = source;
  const attempts = new Map<string, number>();
  const observation = new RunnerModelCatalogObservation({
    runners: () => ['retry-pair-a', 'retry-pair-b'],
    select: async () => selected,
    nodes: async () => [
      {
        machine: 'node-a',
        list: async (catalog) => {
          const key = catalog.nodeCommand;
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          throw new Error('fixture command failed');
        },
      },
    ],
    hasInterest: () => false,
    changed: () => {},
    now: () => clock.now,
    scheduleRetry: clock.schedule,
  });
  try {
    await Promise.all([observation.read('retry-pair-a'), observation.read('retry-pair-b')]);
    assert.equal(clock.timers.size, 2);
    await clock.advance(15_000);
    assert.equal(attempts.get('fixture-pi'), 4);
    selected = undefined;
    await observation.read('retry-pair-a');
    assert.equal(clock.timers.size, 1);
    await clock.advance(30_000);
    assert.equal(attempts.get('fixture-pi'), 5);
  } finally {
    await observation.stop();
  }
  assert.equal(clock.timers.size, 0);
});

for (const removal of ['retry', 'sample'] as const) {
  test(`a removed node cancels its retry during the next ${removal}`, async (t) => {
    const runner = `retry-removed-${removal}`;
    let attempts = 0;
    const nodes: ModelCatalogNode[] = [
      {
        machine: 'node-a',
        list: async () => {
          attempts++;
          throw new Error('fixture node disconnected');
        },
      },
    ];
    const { observation, clock } = fixture(runner, nodes);
    t.after(() => observation.stop());
    await observation.read(runner);
    assert.equal(clock.timers.size, 1);
    nodes.length = 0;
    if (removal === 'sample') {
      await observation.read(runner);
      assert.equal(clock.timers.size, 0);
    }
    await clock.advance(15_000);
    assert.equal(attempts, 1);
    assert.equal(clock.timers.size, 0);
    await clock.advance(600_000);
    assert.equal(attempts, 1);
  });
}

for (const listing of ['retry', 'sample'] as const) {
  test(`the next ${listing} uses the current execution slot and cancels the old retry`, async (t) => {
    const runner = `retry-changed-slot-${listing}`;
    const slots: string[] = [];
    const nodes: ModelCatalogNode[] = [
      {
        machine: 'node-a',
        list: async () => {
          slots.push('old-slot');
          throw new Error('fixture slot removed');
        },
      },
    ];
    const { observation, clock } = fixture(runner, nodes);
    t.after(() => observation.stop());
    await observation.read(runner);
    nodes[0] = {
      machine: 'node-a',
      list: async () => {
        slots.push('current-slot');
        return 'litellm/fixture-current';
      },
    };
    if (listing === 'sample') await observation.read(runner);
    else await clock.advance(15_000);
    assert.deepEqual(slots, ['old-slot', 'current-slot']);
    assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), ['litellm/fixture-current']);
    assert.equal(clock.timers.size, 0);
    await clock.advance(600_000);
    assert.equal(slots.length, 2);
  });
}

test('stop drains a pruned node listing and fences its late reply', async (t) => {
  const runner = 'retry-pruned-pending';
  let attempts = 0;
  let complete!: (output: string) => void;
  const nodes: ModelCatalogNode[] = [
    {
      machine: 'node-a',
      list: async () => {
        if (++attempts === 1) throw new Error('fixture node disconnected');
        return new Promise<string>((resolve) => {
          complete = resolve;
        });
      },
    },
  ];
  const { observation, clock } = fixture(runner, nodes);
  t.after(() => observation.stop());
  await observation.read(runner);
  await clock.advance(15_000);
  nodes.length = 0;
  await observation.read(runner);
  let drained = false;
  const stopping = observation.stop().then(() => {
    drained = true;
  });
  await settle();
  assert.equal(drained, false);
  complete('litellm/fixture-late');
  await stopping;
  assert.equal(nodeModelCatalogs.listing(runner, 'node-a'), undefined);
  assert.equal(clock.timers.size, 0);
});

for (const outcome of ['failing', 'recovered'] as const) {
  test(`${outcome} node retries preserve retained age and the healthy node refresh deadline`, async (t) => {
    const runner = `retry-healthy-cadence-${outcome}`;
    let healthyAttempts = 0;
    let failingAttempts = 0;
    let recovered = false;
    const { observation, clock, interest } = fixture(runner, [
      {
        machine: 'node-a',
        list: async () => {
          failingAttempts++;
          if (!recovered) throw new Error('fixture node disconnected');
          return 'litellm/fixture-recovered';
        },
      },
      {
        machine: 'node-b',
        list: async () => {
          healthyAttempts++;
          return `litellm/fixture-healthy-${healthyAttempts}`;
        },
      },
    ]);
    t.after(() => observation.stop());
    interest();
    const initial = await observation.read(runner, managed);
    for (const delay of [15_000, 30_000, 60_000]) {
      await clock.advance(delay);
      assert.equal((await observation.read(runner, managed)).observation?.observedAt, 1000);
      await observation.tick();
      assert.equal(healthyAttempts, 1);
    }
    recovered = outcome === 'recovered';
    await clock.advance(120_000);
    const recovery = await observation.read(runner, managed);
    assert.equal(recovery.observation?.observedAt, initial.observation?.observedAt);
    assert.equal(
      recovery.models.some((model) => model.id === 'litellm/fixture-recovered'),
      recovered,
    );
    assert.equal(clock.timers.size, recovered ? 0 : 1);
    await clock.advance(75_000 - 1);
    await observation.tick();
    assert.equal(healthyAttempts, 1);
    await clock.advance(1);
    assert.equal((await observation.read(runner, managed)).observation?.status, 'stale');
    await observation.tick();
    assert.equal(healthyAttempts, 2);
    assert.equal(failingAttempts, 6);
    const refreshed = await observation.read(runner, managed);
    assert.equal(refreshed.observation?.observedAt, clock.now);
    assert.ok(refreshed.models.some((model) => model.id === 'litellm/fixture-healthy-2'));
  });
}

function piListing(
  ids: readonly string[],
  status = 'ready',
  count = ids.filter((id) => id.startsWith('litellm/')).length,
) {
  return `${JSON.stringify({ type: 'farmslot.pi-provider-discovery', sources: [{ provider: 'litellm', configured: true, status, modelCount: count }] })}\nprovider model\n${ids.map((id) => id.replace('/', ' ')).join('\n')}\n`;
}
const fullPiIds = [
  'anthropic/claude-haiku-5-5',
  ...Array.from({ length: 7 }, (_, i) => `litellm/fixture-${i}`),
];
const smallPiIds = fullPiIds.slice(0, 2);

for (const failure of ['failed', 'missing'] as const) {
  test(`partial Pi listing with ${failure} configured discovery retains models and retries without renewing healthy age`, async (t) => {
    const runner = `partial-pi-${failure}`;
    const piSource = getRunnerDefinition('pi').modelCatalog;
    assert.ok(piSource && 'nodeCommand' in piSource);
    let output = piListing(fullPiIds);
    let healthyAttempts = 0;
    const { observation, clock, interest } = fixture(
      runner,
      [
        { machine: 'node-a', list: async () => output },
        {
          machine: 'node-b',
          list: async () => {
            healthyAttempts++;
            return piListing(fullPiIds);
          },
        },
      ],
      piSource,
    );
    t.after(() => observation.stop());
    interest();
    const first = await observation.read(runner, managed);
    output = piListing(fullPiIds.slice(0, 1), failure === 'failed' ? 'failed' : 'ready', 7);
    await clock.advance(300_000);
    await observation.tick();
    const sampledAt = (await observation.read(runner, managed)).observation?.observedAt;
    for (const delay of [15_000, 30_000, 60_000]) {
      assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), fullPiIds);
      assert.deepEqual((await observation.read(runner, managed)).models, first.models);
      assert.equal(clock.delays.at(-1), delay);
      await clock.advance(delay);
      assert.equal(healthyAttempts, 2);
      assert.equal((await observation.read(runner, managed)).observation?.observedAt, sampledAt);
    }
    output = piListing([...fullPiIds, 'litellm/fixture-recovered']);
    await clock.advance(120_000);
    assert.equal(clock.timers.size, 0);
    assert.ok(
      (await observation.read(runner, managed)).models.some(
        (model) => model.id === 'litellm/fixture-recovered',
      ),
    );
    assert.equal((await observation.read(runner, managed)).observation?.observedAt, sampledAt);
    await clock.advance(74_999);
    await observation.tick();
    assert.equal(healthyAttempts, 2);
    await clock.advance(1);
    await observation.tick();
    assert.equal(healthyAttempts, 3);
  });
}

test('successful configured-provider shrink requires three identical listings; recovery resets confirmation', async (t) => {
  const runner = 'partial-pi-shrink';
  const piSource = getRunnerDefinition('pi').modelCatalog;
  assert.ok(piSource && 'nodeCommand' in piSource);
  let output = piListing(fullPiIds);
  const { observation, clock } = fixture(
    runner,
    [{ machine: 'node-a', list: async () => output }],
    piSource,
  );
  t.after(() => observation.stop());
  await observation.read(runner);
  output = piListing(smallPiIds);
  await observation.read(runner);
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), fullPiIds);
  output = piListing(fullPiIds);
  await clock.advance(15_000);
  assert.equal(clock.timers.size, 0);
  output = piListing(smallPiIds);
  await observation.read(runner);
  await clock.advance(15_000);
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), fullPiIds);
  await clock.advance(30_000);
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), smallPiIds);
  assert.equal(clock.timers.size, 0);
});

test('configured discovery failure on the first listing retries without publishing built-ins as complete', async (t) => {
  const runner = 'partial-pi-cold';
  const piSource = getRunnerDefinition('pi').modelCatalog;
  assert.ok(piSource && 'nodeCommand' in piSource);
  let output = piListing(fullPiIds.slice(0, 1), 'failed', 0);
  const { observation, clock } = fixture(
    runner,
    [{ machine: 'node-a', list: async () => output }],
    piSource,
  );
  t.after(() => observation.stop());
  assert.equal((await observation.read(runner, managed)).status, 'unavailable');
  assert.equal(nodeModelCatalogs.listing(runner, 'node-a'), undefined);
  output = piListing(fullPiIds);
  await clock.advance(15_000);
  assert.deepEqual(nodeModelCatalogs.listing(runner, 'node-a'), fullPiIds);
  assert.equal(clock.timers.size, 0);
});
