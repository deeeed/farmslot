import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { GatewayMethodError } from '../../core/method-error.js';
import { githubQueryBudget } from '../../integrations/github-query-budget.js';
import { resourceRevisions } from '../../resources/revisions.js';

import {
  PR_DETAIL_CLIENT_INTEREST_MS,
  PR_DETAIL_READY_MS,
  PR_DETAIL_STALE_MS,
  PRDetailCollector,
  type UpstreamSample,
} from './detail-collector.js';

interface Query {
  id: string;
}

const managed = { legacyInterest: false };
let serial = 0;

function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function harness(
  fetch: (force: boolean) => Promise<UpstreamSample<string>>,
  seed?: () => Promise<UpstreamSample<string> | undefined>,
  signature?: (value: string) => string,
) {
  const clock = { now: 1_000 };
  const forces: boolean[] = [];
  // Unique method names keep revision counters independent across tests.
  const collector = new PRDetailCollector<Query, string>({
    method: `test.detail.${++serial}`,
    normalize: (params) => {
      const id = (params as Partial<Query>)?.id;
      if (typeof id !== 'string') throw new Error('Provide an id');
      return { id };
    },
    now: () => clock.now,
    fetch: (_params, force) => {
      forces.push(force);
      return fetch(force);
    },
    ...(seed ? { seed } : {}),
    ...(signature ? { signature } : {}),
  });
  const revision = () => resourceRevisions.revision(collector.resourceKey({ id: 'a' }));
  return { clock, collector, forces, revision };
}

afterEach(() => {
  githubQueryBudget.resetForTests();
});

describe('PR detail collector', () => {
  test('concurrent cold reads share one collection whose success time is its completion', async () => {
    const pending = gate();
    const { clock, collector, forces, revision } = harness(async () => {
      await pending.wait;
      clock.now = 5_000;
      return { value: 'v1' };
    });
    assert.match(collector.resourceKey({ id: 'a' }).queryId, /^test\.detail\.\d+:\{"id":"a"\}$/);
    const reads = Promise.all([collector.read({ id: 'a' }, managed), collector.read({ id: 'a' })]);
    clock.now = 3_000;
    pending.open();
    const [first, second] = await reads;
    assert.deepEqual(forces, [false]);
    assert.deepEqual(first, second);
    assert.deepEqual(first.observation, { status: 'ready', observedAt: 5_000 });
    assert.equal(revision(), 1);
    await assert.rejects(collector.read({}), (error: unknown) => {
      assert.ok(error instanceof GatewayMethodError);
      assert.equal(error.code, 'INVALID_PARAMS');
      return true;
    });
  });

  test('a failure keeps the last success with its original age and a sanitized error', async () => {
    let fail = false;
    const { clock, collector, revision } = harness(async () => {
      if (fail) throw new Error('gh: HTTP 401 token ghp_secret at /Users/me/.config/gh/hosts.yml');
      return { value: 'v1' };
    });
    await collector.read({ id: 'a' });
    const before = revision();
    fail = true;
    clock.now += PR_DETAIL_STALE_MS;
    const failed = await collector.read({ id: 'a' });
    assert.equal(failed.value, 'v1');
    assert.deepEqual(failed.observation, {
      status: 'stale',
      observedAt: 1_000,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'GitHub could not be read.' },
    });
    assert.equal(revision(), before + 1, 'the new error is published');
  });

  test('a cold failure invents no success and retries only after the cadence', async () => {
    let outcome: 'fail' | 'ok' | 'gone' = 'fail';
    const { clock, collector, forces } = harness(async () => {
      if (outcome === 'fail') throw new Error('network down');
      if (outcome === 'gone') throw new GatewayMethodError('NOT_FOUND', 'org/app#1 is gone');
      return { value: 'v1' };
    });
    await assert.rejects(collector.read({ id: 'a' }), /network down/);
    await assert.rejects(collector.read({ id: 'a' }), /network down/);
    assert.equal(forces.length, 1, 'the cold failure is retained, not retried per read');
    clock.now += PR_DETAIL_STALE_MS;
    outcome = 'ok';
    assert.equal((await collector.read({ id: 'a' })).value, 'v1');
    outcome = 'gone';
    clock.now += PR_DETAIL_STALE_MS;
    await assert.rejects(collector.read({ id: 'a' }), (error: unknown) => {
      assert.equal((error as GatewayMethodError).code, 'NOT_FOUND');
      return true;
    });
    await assert.rejects(
      collector.read({ id: 'a' }, managed),
      /is gone/,
      'an authorized absence leaves no readable value',
    );
  });

  test('explicit force joins forced work in flight and fails visibly', async () => {
    let pending = gate();
    let fail = false;
    const { clock, collector, forces } = harness(async () => {
      await pending.wait;
      if (fail) throw new Error('GitHub down');
      return { value: `v${forces.length}` };
    });
    pending.open();
    await collector.read({ id: 'a' });
    pending = gate();
    clock.now += PR_DETAIL_STALE_MS;
    const passive = collector.read({ id: 'a' });
    const forced = [
      collector.read({ id: 'a' }, { force: true }),
      collector.read({ id: 'a' }, { force: true }),
    ];
    pending.open();
    await passive;
    const [first, second] = await Promise.all(forced);
    assert.deepEqual(forces, [false, false, true], 'one forced check queued behind passive work');
    assert.equal(first.value, 'v3');
    assert.equal(second.value, 'v3');
    fail = true;
    await assert.rejects(
      collector.read({ id: 'a' }, { force: true }),
      /GitHub down/,
      'a forced check never answers with the older value',
    );
  });

  test('a read waits for a forced check already in flight', async () => {
    let pending = gate();
    const { collector, forces } = harness(async () => {
      await pending.wait;
      return { value: `v${forces.length}` };
    });
    pending.open();
    await collector.read({ id: 'a' }, managed);
    pending = gate();
    const forced = collector.read({ id: 'a' }, { force: true });
    const passive = collector.read({ id: 'a' }, managed);
    pending.open();
    assert.equal((await passive).value, 'v2', 'never answered from before the explicit check');
    assert.equal((await forced).value, 'v2');
    assert.deepEqual(forces, [false, true]);
  });

  test('passive collection follows interest at a cadence of at least one minute', async () => {
    let version = 0;
    const { clock, collector, forces } = harness(async () => ({ value: `v${version}` }));
    let observed = false;
    const stop = collector.start({ hasInterest: () => observed });
    try {
      await collector.read({ id: 'a' }, managed);
      clock.now += PR_DETAIL_STALE_MS + 1;
      await collector.tick();
      assert.equal(forces.length, 1, 'no managed or legacy reader is interested');
      observed = true;
      version = 1;
      await collector.tick();
      assert.equal(forces.length, 2);
      clock.now += PR_DETAIL_STALE_MS - 1;
      await collector.tick();
      assert.equal(forces.length, 2, 'never sooner than one minute');
      clock.now += 1;
      await collector.tick();
      assert.equal(forces.length, 3);
      clock.now += PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, 3, 'an unchanged result slows the next collection');
      clock.now += PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, 4);

      observed = false;
      clock.now += 10 * PR_DETAIL_STALE_MS;
      await collector.read({ id: 'a' }, { legacyClientId: 'old-client' });
      const legacyRead = forces.length;
      clock.now += 10 * PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, legacyRead, 'legacy interest expired');
      await collector.read({ id: 'a' }, { legacyClientId: 'old-client' });
      await collector.read({ id: 'a' }, { legacyClientId: 'new-client', legacyInterest: false });
      clock.now += PR_DETAIL_CLIENT_INTEREST_MS - 1;
      await collector.tick();
      assert.equal(forces.length, legacyRead + 2, 'unexpired legacy interest keeps collecting');
      collector.forget('old-client');
      clock.now += 10 * PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, legacyRead + 2, 'a forgotten legacy reader stops collection');

      await collector.read({ id: 'a' }, { legacyClientId: 'mixed' });
      await collector.read({ id: 'a' }, { legacyClientId: 'mixed', legacyInterest: false });
      clock.now += 10 * PR_DETAIL_STALE_MS;
      const managedOnly = forces.length;
      await collector.tick();
      assert.equal(forces.length, managedOnly, 'a warm managed read withdraws legacy interest');
    } finally {
      await stop();
    }
  });

  test('reserved GraphQL budget pauses passive collection', async () => {
    const { clock, collector, forces } = harness(async () => ({ value: 'v1' }));
    const stop = collector.start({ hasInterest: () => true });
    try {
      await collector.read({ id: 'a' }, managed);
      githubQueryBudget.observe('credential', {
        remaining: 0,
        cost: 1,
        resetAt: new Date(Date.now() + 120_000).toISOString(),
      });
      clock.now += 10 * PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, 1);
    } finally {
      await stop();
    }
  });

  test('identical samples that differ only in fetch time neither publish nor reset backoff', async () => {
    let sample = 0;
    const { clock, collector, forces, revision } = harness(
      async () => ({ value: `same-pr@fetch-${++sample}` }),
      undefined,
      (value) => value.split('@')[0]!,
    );
    const stop = collector.start({ hasInterest: () => true });
    try {
      await collector.read({ id: 'a' }, managed);
      const before = revision();
      clock.now += PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, 2);
      assert.equal(revision(), before, 'a new fetch time alone is not published');
      clock.now += PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, 2, 'the unchanged streak slows the next collection');
      clock.now += PR_DETAIL_STALE_MS;
      await collector.tick();
      assert.equal(forces.length, 3);
      assert.equal(revision(), before);
      const read = await collector.read({ id: 'a' }, managed);
      assert.equal(read.observation.observedAt, clock.now, 'source age stays in the observation');
    } finally {
      await stop();
    }
  });

  test('freshness expiry is published while a reserved budget defers collection', async () => {
    const { clock, collector, forces, revision } = harness(async () => ({ value: 'v1' }));
    const stop = collector.start({ hasInterest: () => true });
    try {
      await collector.read({ id: 'a' }, managed);
      const before = revision();
      githubQueryBudget.observe('credential', {
        remaining: 0,
        cost: 1,
        resetAt: new Date(Date.now() + 120_000).toISOString(),
      });
      clock.now += PR_DETAIL_READY_MS;
      await collector.tick();
      assert.equal(forces.length, 1, 'the reserved budget still defers collection');
      assert.equal(revision(), before + 1, 'ready to stale is published');
      assert.equal((await collector.read({ id: 'a' }, managed)).observation.status, 'stale');
      await collector.tick();
      assert.equal(revision(), before + 1, 'an unchanged state is not published again');
    } finally {
      await stop();
    }
  });

  test('stop drains collection in flight and suppresses late publication', async () => {
    let pending = gate();
    const { clock, collector, forces, revision } = harness(async () => {
      await pending.wait;
      return { value: `v${forces.length}` };
    });
    const stop = collector.start({ hasInterest: () => true });
    pending.open();
    await collector.read({ id: 'a' }, managed);
    pending = gate();
    clock.now += PR_DETAIL_STALE_MS;
    const ticking = collector.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forces.length, 2);
    const before = revision();
    const stopping = stop();
    pending.open();
    await Promise.all([stopping, ticking]);
    assert.equal(revision(), before, 'late completion is not published');
    clock.now += 10 * PR_DETAIL_STALE_MS;
    await collector.tick();
    assert.equal(forces.length, 2, 'no collection after stop');
    await assert.rejects(collector.read({ id: 'a' }, { force: true }), /stopped/);
  });

  test('retained observations from another owner seed and update without a fetch', async () => {
    let fail = false;
    const { clock, collector, forces, revision } = harness(
      async () => {
        if (fail) throw new Error('down');
        return { value: 'fetched' };
      },
      async () => ({ value: 'seeded', observedAt: 900 }),
    );
    const seeded = await collector.read({ id: 'a' });
    assert.equal(seeded.value, 'seeded');
    assert.deepEqual(seeded.observation, { status: 'ready', observedAt: 900 });
    assert.equal(forces.length, 0, 'a fresh retained value needs no second GitHub read');
    const before = revision();
    collector.observe(() => ({ value: 'older', observedAt: 800 }));
    assert.equal(revision(), before);
    collector.observe(() => ({ value: 'newer', observedAt: 950 }));
    assert.equal(revision(), before + 1);
    assert.equal((await collector.read({ id: 'a' }, managed)).value, 'newer');

    fail = true;
    clock.now += PR_DETAIL_STALE_MS;
    const failed = await collector.read({ id: 'a' });
    assert.equal(failed.observation.error?.code, 'UPSTREAM_UNAVAILABLE');
    collector.observe(() => ({ value: 'before-failure', observedAt: 960 }));
    assert.equal(
      (await collector.read({ id: 'a' }, managed)).observation.error?.code,
      'UPSTREAM_UNAVAILABLE',
      'a value observed before the failure keeps the error visible',
    );
    collector.observe(() => ({ value: 'after-failure', observedAt: clock.now + 1 }));
    const recovered = await collector.read({ id: 'a' }, managed);
    assert.equal(recovered.value, 'after-failure');
    assert.equal(recovered.observation.error, undefined);
  });

  test('a value for a superseded local context is re-collected before it is served', async () => {
    let context = 'feat/a';
    const { collector, forces } = harness(async () => ({ value: context }));
    assert.equal((await collector.read({ id: 'a' }, managed)).value, 'feat/a');
    context = 'feat/b';
    const current = await collector.read(
      { id: 'a' },
      { ...managed, accept: (value) => value === 'feat/b' },
    );
    assert.equal(current.value, 'feat/b');
    assert.equal(forces.length, 2);
  });
});
