// Entity sync through the shared cache (ADR-071 Amendment 4): every scenario counts the reads
// the cache sends, by method and read shape, against a scripted gateway.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayResourceCache } from '../../src/client-cache/cache.js';
import { resourceQuery } from '../../src/client-cache/registry.js';
import { createMemoryResourceStore, type ResourceStore } from '../../src/client-cache/store.js';
import type { ResourceQueryState } from '../../src/client-cache/types.js';
import type { PRStatus } from '../../src/contracts/reviews.js';
import type { SlotEntity } from '../../src/contracts/slots.js';
import { computeSummary } from '../../src/fleet/summary.js';
import type { FleetStatusResult } from '../../src/rpc/fleet.js';
import type { PRListResult } from '../../src/rpc/pr.js';
import {
  EntityGateway,
  flush,
  machine,
  pr,
  prId,
  slot,
  versionOf,
} from '../fixtures/entity-gateway.js';

const fleetQuery = resourceQuery<FleetStatusResult>('fleet.status');
const prQuery = (project?: string) =>
  resourceQuery<PRListResult>('pr.list', project === undefined ? {} : { project });

const FLEET_ROWS_ID = 'fleet.status:{"versions":true}';
const prRowsId = (project?: string) =>
  project === undefined
    ? 'pr.list:{"versions":true}'
    : `pr.list:{"project":"${project}","versions":true}`;

function setup(gateway: EntityGateway, store?: ResourceStore) {
  const cache = createGatewayResourceCache({ transport: gateway, ...(store ? { store } : {}) });
  const states: ResourceQueryState[] = [];
  const stops: Array<() => void> = [];
  return {
    cache,
    states,
    watch<T>(query: ReturnType<typeof resourceQuery<T>>) {
      stops.push(cache.observe(query, (state) => states.push(state)));
    },
    read<T>(query: ReturnType<typeof resourceQuery<T>>) {
      return cache.read(query);
    },
    /** Every observer leaves, as when the screen is closed. */
    unwatch() {
      for (const stop of stops.splice(0)) stop();
    },
    async close() {
      for (const stop of stops) stop();
      await cache.dispose();
    },
  };
}

/** Resolves when `arrived` does, or fails the test with `message` after a short ceiling. */
async function within(arrived: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      arrived,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new assert.AssertionError({ message })), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls until `ready()` holds, or fails the test with `message` after a short ceiling. */
async function until(ready: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 900;
  while (!ready()) {
    if (performance.now() > deadline) assert.fail(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const slotsOf = (state: ResourceQueryState<FleetStatusResult>) =>
  state.data?.fleet.slots.map((row) => `${row.slot}:${row.branch}`) ?? [];

async function seededStore(
  gateway: EntityGateway,
  rows: Array<{ collection: string; id: string; body: unknown; version: string; data: unknown }>,
): Promise<ResourceStore> {
  const memory = createMemoryResourceStore();
  await memory.setMetadata({
    scope: gateway.connection.scope,
    authority: gateway.connection.authority!,
  });
  for (const row of rows)
    await memory.mergeRows!(row.collection, {
      entry: { id: row.collection, data: row.data, observedAt: 1_000, bytes: 10 },
      upserts: [{ id: row.id, version: row.version, projection: {}, body: row.body, bytes: 10 }],
      deletes: [],
    });
  // The cache warms only persistent stores at startup; this memory store stands in for one.
  return { ...memory, persistent: true };
}

test('a data-only slot change costs no read; a membership change costs one versions read', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a'));
  gateway.slots.set('b', slot('b'));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(gateway.requests('fleet.status', 'versions').length, 1);
    assert.equal(gateway.requests('fleet.status', 'ids').length, 1);
    const before = gateway.log.length;

    gateway.writeSlot(slot('a', { branch: 'feature' }));
    await flush();
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:feature', 'b:main']);
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(gateway.log.length, before, 'a pushed slot costs no read');

    gateway.writeSlot(slot('c'));
    await flush();
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:feature', 'b:main', 'c:main']);
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(gateway.requests('fleet.status', 'versions').length, 2, 'one versions read');
    assert.equal(
      gateway.requests('fleet.status', 'ids').length,
      1,
      'the added slot came with its notification',
    );
    assert.equal(gateway.requests('fleet.status', 'full').length, 0);
  } finally {
    await client.close();
  }
});

test('finding 1: a reconnect verifies the collection with one versions read before it is ready', async () => {
  const gateway = new EntityGateway();
  for (const id of ['a', 'b', 'c']) gateway.slots.set(id, slot(id));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    const versionsBefore = gateway.requests('fleet.status', 'versions').length;
    const idsBefore = gateway.requests('fleet.status', 'ids').length;

    gateway.setConnection({ connected: false });
    await flush();
    // Changed while this client was away: no notification reaches it.
    gateway.slots.set('b', slot('b', { branch: 'moved' }));
    const versionsReply = gateway.hold((entry) => entry.params.versions === true);
    gateway.reconnect('epoch-2');
    await within(versionsReply.arrived, 'a reconnect sends a versions read');
    const waiting = client.read(fleetQuery);
    assert.notEqual(waiting.status, 'ready', 'unverified rows are not current');
    assert.deepEqual(slotsOf(waiting), ['a:main', 'b:main', 'c:main'], 'rows stay displayed');
    versionsReply.release();
    await flush();

    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:main', 'b:moved', 'c:main']);
    assert.equal(gateway.requests('fleet.status', 'versions').length - versionsBefore, 1);
    const ids = gateway.requests('fleet.status', 'ids').slice(idsBefore);
    assert.deepEqual(
      ids.map((entry) => entry.params.ids),
      [['b']],
      'only the changed slot is read',
    );
  } finally {
    await client.close();
  }
});

test('finding 1: a reconnect re-verifies a PR collection too', async () => {
  const gateway = new EntityGateway();
  const one = pr('o/r', 1);
  gateway.writePR(one);
  const client = setup(gateway);
  try {
    client.watch(prQuery());
    await flush();
    assert.equal(client.read(prQuery()).status, 'ready');
    const before = gateway.requests('pr.list').length;
    gateway.setConnection({ connected: false });
    await flush();
    gateway.prs.get('')!.set(prId(one), pr('o/r', 1, { title: 'renamed' }));
    gateway.reconnect('epoch-2');
    await flush();
    assert.equal(client.read(prQuery()).data?.prs[0].title, 'renamed');
    const reads = gateway.requests('pr.list').slice(before);
    assert.equal(reads.filter((entry) => entry.params.versions === true).length, 1);
    assert.deepEqual(
      reads.filter((entry) => Array.isArray(entry.params.ids)).map((entry) => entry.params.ids),
      [[prId(one)]],
    );
  } finally {
    await client.close();
  }
});

test('finding 2: a push that lands while a versions read is outstanding wins over its reply', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a'));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    // A membership change asks for a versions read; its reply is computed before the push.
    const versionsReply = gateway.hold((entry) => entry.params.versions === true);
    gateway.writeSlot(slot('b'));
    await within(versionsReply.arrived, 'the held read was sent');
    gateway.writeSlot(slot('a', { branch: 'v2' }));
    await flush();
    const idsBefore = gateway.requests('fleet.status', 'ids').length;
    versionsReply.release();
    await flush();

    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:v2', 'b:main']);
    assert.equal(client.read(fleetQuery).status, 'ready');
    const ids = gateway.requests('fleet.status', 'ids').slice(idsBefore);
    assert.ok(
      ids.every((entry) => !(entry.params.ids as string[]).includes('a')),
      `the stale listing of a must not cause a read of a (got ${JSON.stringify(ids)})`,
    );
  } finally {
    await client.close();
  }
});

test('finding 2: a push that lands while an ids page is outstanding wins over the page', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a'));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    gateway.setConnection({ connected: false });
    await flush();
    gateway.slots.set('a', slot('a', { branch: 'v2' }));
    const page = gateway.hold((entry) => Array.isArray(entry.params.ids));
    gateway.reconnect();
    await within(page.arrived, 'the held read was sent');
    gateway.writeSlot(slot('a', { branch: 'v3' }));
    await flush();
    page.release();
    await flush();
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:v3']);
    assert.equal(client.read(fleetQuery).status, 'ready');
  } finally {
    await client.close();
  }
});

test('finding 3: a change without a usable inline entity reads that entity by id', async () => {
  const gateway = new EntityGateway();
  for (const id of ['a', 'b', 'c', 'd']) gateway.slots.set(id, slot(id));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    const idsBefore = gateway.requests('fleet.status', 'ids').length;

    gateway.writeSlot(slot('a', { branch: 'no-body' }), 'none');
    await flush();
    assert.deepEqual(slotsOf(client.read(fleetQuery))[0], 'a:no-body', 'absent body is read');

    // A body that fails the guard is not applied; the row is read instead.
    gateway.slots.set('b', slot('b', { branch: 'guarded' }));
    gateway.publish([
      {
        key: { family: 'slot', slotId: 'b' },
        changedEntity: { family: 'slot', entity: slot('b', { branch: 'bad' }), version: 'x' },
      },
      { key: { family: 'slots', scope: 'farm' } },
    ]);
    await flush();
    assert.equal(slotsOf(client.read(fleetQuery))[1], 'b:guarded', 'a mismatched version is read');

    // A version-only change the client already holds costs nothing; a new one is read.
    gateway.writeSlot(slot('c'), 'version');
    gateway.writeSlot(slot('d', { branch: 'version-only' }), 'version');
    await flush();
    assert.equal(slotsOf(client.read(fleetQuery))[3], 'd:version-only');

    const ids = gateway.requests('fleet.status', 'ids').slice(idsBefore);
    assert.deepEqual(
      ids.map((entry) => entry.params.ids),
      [['a'], ['b'], ['d']],
    );
    assert.equal(client.read(fleetQuery).status, 'ready');

    gateway.deleteSlot('c');
    await flush();
    assert.deepEqual(
      slotsOf(client.read(fleetQuery)).map((row) => row.split(':')[0]),
      ['a', 'b', 'd'],
    );
  } finally {
    await client.close();
  }
});

test('finding 3: a PR change without an inline entity reads that PR by id', async () => {
  const gateway = new EntityGateway();
  gateway.writePR(pr('o/r', 1));
  const client = setup(gateway);
  try {
    client.watch(prQuery());
    await flush();
    const idsBefore = gateway.requests('pr.list', 'ids').length;
    gateway.writePR(pr('o/r', 1, { title: 'updated' }), undefined, 'none');
    await flush();
    assert.equal(client.read(prQuery()).data?.prs[0].title, 'updated');
    assert.deepEqual(
      gateway
        .requests('pr.list', 'ids')
        .slice(idsBefore)
        .map((entry) => entry.params.ids),
      [['o/r/1']],
    );
  } finally {
    await client.close();
  }
});

test('finding 4: an entity deleted during catch-up ends in a membership check, not a loop', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a'));
  gateway.slots.set('b', slot('b'));
  const versionsReply = gateway.hold((entry) => entry.params.versions === true);
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await within(versionsReply.arrived, 'the held read was sent');
    // a disappears after the versions reply was computed; its notification is still queued.
    gateway.slots.delete('a');
    versionsReply.release();
    await flush();
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['b:main']);
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.ok(
      gateway.log.length <= 4,
      `bounded reads: versions, ids, versions (got ${gateway.log.length})`,
    );
  } finally {
    await client.close();
  }
});

test('finding 5: stored rows that fail the guard are dropped and read again', async () => {
  const gateway = new EntityGateway();
  const good = slot('good');
  gateway.slots.set('good', good);
  // An unusable stored row whose version matches its body and the gateway's listing: only the
  // shape guard can refuse it. Admitted, summary assembly would read `health.ssh` of undefined.
  const broken = { slot: 'broken', lifecycle: 'ready' };
  gateway.slots.set('broken', slot('broken'));
  gateway.listedVersions.set('broken', versionOf(broken));
  const store = await seededStore(gateway, [
    { collection: FLEET_ROWS_ID, id: 'good', body: good, version: versionOf(good), data: {} },
    { collection: FLEET_ROWS_ID, id: 'broken', body: broken, version: versionOf(broken), data: {} },
  ]);
  const client = setup(gateway, store);
  try {
    client.watch(fleetQuery);
    await flush();
    const state = client.read(fleetQuery);
    assert.notEqual(state.status, 'error', JSON.stringify(state.error));
    assert.deepEqual(slotsOf(state), ['good:main', 'broken:main'], 'in the gateway order');
    assert.deepEqual(
      gateway.requests('fleet.status', 'ids').map((entry) => entry.params.ids),
      [['broken']],
      'only the rejected row is read',
    );
  } finally {
    await client.close();
  }
});

for (const [what, contexts] of [
  ['hold a null', [null]],
  ['lack the label the slot view sorts by', [{ id: 'a', role: 'review', status: 'working' }]],
] as const)
  test(`R2: a stored slot whose agent contexts ${what} is read again`, async () => {
    const gateway = new EntityGateway();
    // The digest matches the body and the gateway lists it: only the guard can refuse the element
    // the slot view dereferences.
    const unusable: unknown = JSON.parse(JSON.stringify({ ...slot('a'), agentContexts: contexts }));
    gateway.slots.set('a', slot('a'));
    gateway.listedVersions.set('a', versionOf(unusable));
    const store = await seededStore(gateway, [
      {
        collection: FLEET_ROWS_ID,
        id: 'a',
        body: unusable,
        version: versionOf(unusable),
        data: {},
      },
    ]);
    const client = setup(gateway, store);
    try {
      client.watch(fleetQuery);
      await flush();
      assert.deepEqual(
        gateway.requests('fleet.status', 'ids').map((entry) => entry.params.ids),
        [['a']],
        'the rejected row is read',
      );
      assert.equal(client.read(fleetQuery).data?.fleet.slots[0].agentContexts, undefined);
    } finally {
      await client.close();
    }
  });

test('finding 5: a pushed PR that fails the guard is read instead', async () => {
  const gateway = new EntityGateway();
  gateway.writePR(pr('o/r', 1));
  const client = setup(gateway);
  try {
    client.watch(prQuery());
    await flush();
    const real = pr('o/r', 1, { title: 'real' });
    gateway.prs.get('')!.set(prId(real), real);
    const unusable = { repo: 'o/r', pr: 1 };
    const collection = gateway.prKey();
    if (collection.family !== 'upstream') throw new Error('PR list key must be upstream');
    gateway.publish([
      {
        key: { ...collection, prKey: prId(real) },
        // The wire carries untrusted JSON; this body lacks the fields consumers read.
        changedEntity: JSON.parse(
          JSON.stringify({ family: 'upstream', entity: unusable, version: versionOf(unusable) }),
        ),
      },
      { key: collection },
    ]);
    await flush();
    assert.equal(client.read(prQuery()).data?.prs[0].title, 'real');
  } finally {
    await client.close();
  }
});

test('finding 19: each catch-up page publishes its rows before the next page', async () => {
  const gateway = new EntityGateway();
  for (let i = 0; i < 25; i++) {
    const id = `s${String(i).padStart(2, '0')}`;
    gateway.slots.set(id, slot(id));
  }
  const second = gateway.hold(
    (entry) => Array.isArray(entry.params.ids) && (entry.params.ids as string[]).length === 5,
  );
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await within(second.arrived, 'the held read was sent');
    await flush();
    const partial = client.read(fleetQuery);
    assert.deepEqual(partial.catchUpProgress, { done: 20, total: 25 });
    assert.equal(partial.data?.fleet.slots.length, 20, 'the first page is on screen');
    second.release();
    await flush();
    assert.equal(client.read(fleetQuery).data?.fleet.slots.length, 25);
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(client.read(fleetQuery).catchUpProgress, undefined);
  } finally {
    await client.close();
  }
});

test('finding 20: a cold start with unchanged PR versions reads no PR bodies', async () => {
  const gateway = new EntityGateway();
  const rows: PRStatus[] = [pr('o/r', 1, { project: 'p' }), pr('o/r', 2, { project: 'p' })];
  for (const row of rows) gateway.writePR(row, 'p');
  const store = await seededStore(
    gateway,
    rows.map((row) => ({
      collection: prRowsId('p'),
      id: prId(row),
      body: row,
      version: versionOf(row),
      data: gateway.prMeta,
    })),
  );
  const client = setup(gateway, store);
  try {
    client.watch(prQuery('p'));
    await flush();
    const state = client.read(prQuery('p'));
    assert.equal(state.status, 'ready', JSON.stringify(state.error));
    assert.deepEqual(state.data?.prs.map(prId), ['o/r/1', 'o/r/2']);
    assert.equal(gateway.requests('pr.list', 'versions').length, 1);
    assert.equal(gateway.requests('pr.list', 'ids').length, 0, 'stored bodies are reused');
    assert.deepEqual(gateway.observers.at(-1), [{ method: 'pr.list', params: { project: 'p' } }]);
  } finally {
    await client.close();
  }
});

test('finding 20: PR rows read by a session are stored for the next one', async () => {
  const gateway = new EntityGateway();
  const row = pr('o/r', 7);
  gateway.writePR(row);
  const memory = createMemoryResourceStore();
  const client = setup(gateway, memory);
  try {
    client.watch(prQuery());
    await flush();
    assert.equal(client.read(prQuery()).status, 'ready');
    const stored = await memory.getRows!(prRowsId());
    assert.deepEqual(
      stored.rows.map(({ id, version }) => ({ id, version })),
      [{ id: prId(row), version: versionOf(row) }],
    );
  } finally {
    await client.close();
  }
});

test('finding 6 (client): a project PR view is admitted as an observer before its versions read', async () => {
  const gateway = new EntityGateway();
  gateway.writePR(pr('o/r', 3, { project: 'p' }), 'p');
  const client = setup(gateway);
  try {
    client.watch(prQuery('p'));
    await flush();
    assert.deepEqual(gateway.observers.at(-1), [{ method: 'pr.list', params: { project: 'p' } }]);
    assert.deepEqual(
      gateway.timeline.slice(0, 2),
      ['observers-applied', 'pr.list versions'],
      'the gateway holds the observer before the read asks its collector',
    );
    assert.equal(client.read(prQuery('p')).status, 'ready');
  } finally {
    await client.close();
  }
});

test('finding 8 (client): a marker advance for PR metadata alone refreshes the observation', async () => {
  const gateway = new EntityGateway();
  gateway.writePR(pr('o/r', 1));
  const client = setup(gateway);
  try {
    client.watch(prQuery());
    await flush();
    assert.equal(client.read(prQuery()).status, 'ready');
    gateway.writePRMeta({
      ...gateway.prMeta,
      observation: {
        status: 'stale',
        observedAt: 1_000,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'GitHub refused' },
      },
    });
    await flush();
    const state = client.read(prQuery());
    assert.equal(state.data?.observation?.error?.message, 'GitHub refused');
    assert.equal(state.status, 'stale', 'a failed refresh is not reported as current');
    assert.equal(gateway.requests('pr.list', 'ids').length, 1, 'no PR body was read again');
  } finally {
    await client.close();
  }
});

test('a refused fleet source reaches an entity-sync client as the error a full read shows', async () => {
  const refusal = { code: 'RESOURCE_OBSERVATION_FAILED', message: 'Git HEAD was deleted.' };
  // What a client on the full read shows once the source refuses its reread.
  const fullGateway = new EntityGateway({ entitySync: false });
  fullGateway.slots.set('a', slot('a'));
  const fullClient = setup(fullGateway);
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a'));
  const client = setup(gateway);
  try {
    fullClient.watch(fleetQuery);
    await flush();
    fullGateway.fleetRefusal = refusal;
    const full = await fullClient.cache.retry(fleetQuery);
    assert.equal(full.error?.code, refusal.code);

    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    const reads = () => gateway.requests('fleet.status').length;
    const settled = reads();

    // The source updates and settles to the same outcome: nothing to read.
    gateway.invalidateSlot('a', false);
    await flush();
    assert.equal(reads(), settled, 'an invalidation with the same outcome costs no read');
    assert.equal(client.read(fleetQuery).status, 'ready');

    // It settles refused: one versions read meets the refusal.
    gateway.fleetRefusal = refusal;
    gateway.invalidateSlot('a', true);
    await flush();
    const failed = client.read(fleetQuery);
    assert.equal(gateway.requests('fleet.status', 'versions').length, 2, 'one versions read');
    assert.equal(reads(), settled + 1, 'and no other read');
    assert.equal(failed.status, full.status, 'the status a full read shows');
    assert.deepEqual(failed.error, full.error, 'with the same error');
    assert.deepEqual(slotsOf(failed), ['a:main'], 'rows stay displayed');

    // It recovers: one versions read clears the error.
    gateway.fleetRefusal = undefined;
    gateway.invalidateSlot('a', true);
    await flush();
    assert.equal(reads(), settled + 2, 'one versions read for the recovery');
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(client.read(fleetQuery).error, undefined);
  } finally {
    await client.close();
    await fullClient.close();
  }
});

test('N1: a machine push that lands while a versions read is outstanding wins over its reply', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a', { machine: 'mac-a' }));
  gateway.machines.set('mac-a', machine('mac-a', 10));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    // A membership change asks for a versions read; its reply is computed before the sample.
    const versionsReply = gateway.hold((entry) => entry.params.versions === true);
    gateway.writeSlot(slot('b', { machine: 'mac-a' }));
    await within(versionsReply.arrived, 'the held read was sent');
    gateway.writeMachine(machine('mac-a', 77));
    await flush();
    versionsReply.release();
    await flush();
    const fleet = client.read(fleetQuery).data?.fleet;
    assert.equal(fleet?.machines?.[0].system?.cpuPercent, 77, 'the newer sample is kept');
    assert.equal(fleet?.slots[0].hostLoad?.cpuPercent, 77);
    assert.equal(client.read(fleetQuery).status, 'ready');
  } finally {
    await client.close();
  }
});

test('N1: a machine push before the first versions reply wins over that reply', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a', { machine: 'mac-a' }));
  gateway.machines.set('mac-a', machine('mac-a', 10));
  const versionsReply = gateway.hold((entry) => entry.params.versions === true);
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await within(versionsReply.arrived, 'the held read was sent');
    gateway.writeMachine(machine('mac-a', 77));
    await flush();
    versionsReply.release();
    await flush();
    assert.equal(client.read(fleetQuery).data?.fleet.machines?.[0].system?.cpuPercent, 77);
    assert.equal(client.read(fleetQuery).status, 'ready');
  } finally {
    await client.close();
  }
});

test('N8: a change for an id the listing does not hold costs one versions read, then settles', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a'));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    const versions = gateway.requests('fleet.status', 'versions').length;
    const ids = gateway.requests('fleet.status', 'ids').length;
    // An overlay write for a slot that left the fleet: no body, no membership change.
    gateway.publish([
      { key: { family: 'slot', slotId: 'gone' } },
      { key: { family: 'slots', scope: 'farm' } },
    ]);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready', 'the view is not left syncing');
    assert.equal(gateway.requests('fleet.status', 'versions').length, versions + 1);
    assert.equal(gateway.requests('fleet.status', 'ids').length, ids, 'nothing to fetch');
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:main']);
  } finally {
    await client.close();
  }
});

const manySlots = (branch: string) =>
  Array.from({ length: 25 }, (_, index) => slot(`s${String(index).padStart(2, '0')}`, { branch }));

test('N3: a gateway that starts entity sync keeps the rows a full read put on screen', async () => {
  const gateway = new EntityGateway({ entitySync: false });
  for (const row of manySlots('main')) gateway.slots.set(row.slot, row);
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).data?.fleet.slots.length, 25);

    gateway.setConnection({ connected: false });
    await flush();
    for (const row of manySlots('moved')) gateway.slots.set(row.slot, row);
    const second = gateway.hold(
      (entry) => Array.isArray(entry.params.ids) && (entry.params.ids as string[]).length === 5,
    );
    gateway.reconnect('epoch-2', true);
    await within(second.arrived, 'the held read was sent');
    await flush();
    const partial = client.read(fleetQuery);
    assert.equal(partial.data?.fleet.slots.length, 25, 'no displayed row leaves the screen');
    assert.equal(slotsOf(partial).filter((row) => row.endsWith(':moved')).length, 20);
    second.release();
    await flush();
    assert.equal(
      slotsOf(client.read(fleetQuery)).filter((row) => row.endsWith(':moved')).length,
      25,
    );
    assert.equal(client.read(fleetQuery).status, 'ready');
  } finally {
    await client.close();
  }
});

test('N3: a stored full snapshot stays on screen while entity sync catches up', async () => {
  const gateway = new EntityGateway();
  for (const row of manySlots('moved')) gateway.slots.set(row.slot, row);
  const memory = createMemoryResourceStore();
  await memory.setMetadata({
    scope: gateway.connection.scope,
    authority: gateway.connection.authority!,
  });
  const stored = manySlots('main');
  await memory.putQuery({
    id: fleetQuery.id,
    data: {
      fleet: {
        checkedAt: '2026-11-11T00:00:00.000Z',
        slots: stored,
        summary: computeSummary(stored),
      },
    },
    observedAt: 1_000,
    bytes: 10,
  });
  const second = gateway.hold(
    (entry) => Array.isArray(entry.params.ids) && (entry.params.ids as string[]).length === 5,
  );
  const client = setup(gateway, { ...memory, persistent: true });
  try {
    client.watch(fleetQuery);
    await within(second.arrived, 'the held read was sent');
    await flush();
    assert.equal(
      client.read(fleetQuery).data?.fleet.slots.length,
      25,
      'stored rows stay displayed',
    );
    second.release();
    await flush();
    assert.equal(
      slotsOf(client.read(fleetQuery)).filter((row) => row.endsWith(':moved')).length,
      25,
    );
  } finally {
    await client.close();
  }
});

test('N3: rows a full read already holds at the listed version are not read again', async () => {
  const gateway = new EntityGateway({ entitySync: false });
  for (const row of manySlots('main')) gateway.slots.set(row.slot, row);
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    gateway.setConnection({ connected: false });
    await flush();
    gateway.slots.set('s03', slot('s03', { branch: 'moved' }));
    gateway.reconnect('epoch-2', true);
    await flush();
    assert.deepEqual(
      gateway.requests('fleet.status', 'ids').map((entry) => entry.params.ids),
      [['s03']],
      'only the changed slot is read',
    );
    assert.equal(client.read(fleetQuery).status, 'ready');
  } finally {
    await client.close();
  }
});

test('R3: entity sync, then a gateway without it, then entity sync again never drops a displayed row', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('s00', slot('s00'));
  const store = createMemoryResourceStore();
  const client = setup(gateway, store);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).data?.fleet.slots.length, 1);

    // The gateway is rolled back: a full read puts 26 slots on screen.
    gateway.setConnection({ connected: false });
    await flush();
    for (const row of [...manySlots('main'), slot('s25')]) gateway.slots.set(row.slot, row);
    gateway.reconnect('epoch-2', false);
    await flush();
    assert.equal(client.read(fleetQuery).data?.fleet.slots.length, 26);
    const shown = client.states.length;

    // It is rolled forward again while every slot changed.
    gateway.setConnection({ connected: false });
    await flush();
    for (const row of [...manySlots('moved'), slot('s25', { branch: 'moved' })])
      gateway.slots.set(row.slot, row);
    gateway.reconnect('epoch-3', true);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(
      slotsOf(client.read(fleetQuery)).filter((row) => row.endsWith(':moved')).length,
      26,
    );
    const counts = client.states
      .slice(shown)
      .map((state: ResourceQueryState<FleetStatusResult>) => state.data?.fleet.slots.length);
    assert.ok(
      counts.every((count) => count === 26),
      `no state shows fewer rows than the full read did (got ${JSON.stringify(counts)})`,
    );
  } finally {
    await client.close();
  }
});

test('R1: a versions reply older than a marker the client has seen is followed by another read', async () => {
  const gateway = new EntityGateway();
  gateway.writePR(pr('o/r', 1));
  const client = setup(gateway);
  try {
    client.watch(prQuery());
    await flush();
    // A versions read is outstanding: its reply carries the marker of the snapshot it read.
    const versionsReply = gateway.hold((entry) => entry.params.versions === true);
    gateway.writePRMeta({ ...gateway.prMeta, refreshing: true });
    await within(versionsReply.arrived, 'the held read was sent');
    // The refresh then fails: newer fields under a newer marker.
    gateway.writePRMeta({
      observation: {
        status: 'stale',
        observedAt: 1_000,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'GitHub refused' },
      },
      fetchedAt: gateway.prMeta.fetchedAt,
    });
    await flush();
    versionsReply.release();
    await flush();
    const state = client.read(prQuery());
    assert.equal(state.data?.observation?.error?.message, 'GitHub refused');
    assert.equal(state.status, 'stale', 'the older snapshot is not left as current');
  } finally {
    await client.close();
  }
});

for (const field of ['checks', 'botComments', 'actionableBotComments', 'failedNames'] as const)
  test(`N2: a pushed PR whose ${field} holds a null is read instead of applied`, async () => {
    const gateway = new EntityGateway();
    gateway.writePR(pr('o/r', 1));
    const client = setup(gateway);
    try {
      client.watch(prQuery());
      await flush();
      const real = pr('o/r', 1, { title: 'real' });
      gateway.prs.get('')!.set(prId(real), real);
      const collection = gateway.prKey();
      if (collection.family !== 'upstream') throw new Error('PR list key must be upstream');
      // The digest matches the body: only the guard can refuse an element consumers dereference.
      const unusable = JSON.parse(
        JSON.stringify({ ...pr('o/r', 1, { title: 'bad' }), [field]: [null] }),
      );
      gateway.publish([
        {
          key: { ...collection, prKey: prId(real) },
          changedEntity: { family: 'upstream', entity: unusable, version: versionOf(unusable) },
        },
        { key: collection },
      ]);
      await flush();
      assert.equal(client.read(prQuery()).data?.prs[0].title, 'real');
    } finally {
      await client.close();
    }
  });

test('N4: a local input change leaves the PR view stale until one versions read at its floor', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  t.mock.method(performance, 'now', () => Date.now());
  const gateway = new EntityGateway();
  const row = pr('o/r', 1);
  gateway.writePR(row);
  const client = setup(gateway);
  try {
    client.watch(prQuery());
    await flush();
    assert.equal(client.read(prQuery()).status, 'ready');
    const reads = () => gateway.requests('pr.list').length;
    const before = reads();

    // A run moved the PR to a slot: the gateway would now answer differently, and pushes nothing.
    gateway.prs.get('')!.set(prId(row), pr('o/r', 1, { slot: 'slot-9' }));
    gateway.publish([{ key: { family: 'runs', scope: 'farm' } }]);
    await flush();
    assert.equal(client.read(prQuery()).status, 'stale', 'not ready for data that may have moved');
    assert.equal(reads(), before, 'the read waits for the floor the view rereads runs at');

    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(gateway.requests('pr.list', 'versions').length, 2, 'one versions read');
    assert.equal(client.read(prQuery()).data?.prs[0].slot, 'slot-9');
    assert.equal(client.read(prQuery()).status, 'ready');
    assert.equal(gateway.requests('pr.list', 'full').length, 0);
  } finally {
    await client.close();
  }
});

test('A: a slot pushed while nobody observes the fleet is shown when it is observed again', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a'));
  gateway.slots.set('b', slot('b'));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    const reads = () => gateway.requests('fleet.status').length;

    // The screen is closed; a slot changes; the screen is opened again.
    client.unwatch();
    gateway.writeSlot(slot('a', { branch: 'feature' }));
    await flush();
    let before = reads();
    client.watch(fleetQuery);
    assert.equal(client.read(fleetQuery).status, 'stale', 'old rows are not shown as current');
    await flush();
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:feature', 'b:main']);
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(reads(), before, 'the pushed row was applied while unobserved: no read');

    // The same with a slot added: the listing is read once.
    client.unwatch();
    gateway.writeSlot(slot('c'));
    await flush();
    before = reads();
    client.watch(fleetQuery);
    await flush();
    assert.deepEqual(slotsOf(client.read(fleetQuery)), ['a:feature', 'b:main', 'c:main']);
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(gateway.requests('fleet.status', 'versions').length, 2, 'one versions read');
    assert.equal(reads(), before + 1);
  } finally {
    await client.close();
  }
});

test('A: a PR pushed while nobody observes the list is shown when it is observed again', async () => {
  const gateway = new EntityGateway();
  gateway.writePR(pr('o/r', 1));
  const client = setup(gateway);
  try {
    client.watch(prQuery());
    await flush();
    assert.equal(client.read(prQuery()).status, 'ready');
    const reads = () => gateway.requests('pr.list').length;

    client.unwatch();
    gateway.writePR(pr('o/r', 1, { title: 'changed' }));
    await flush();
    let before = reads();
    client.watch(prQuery());
    assert.equal(client.read(prQuery()).status, 'stale', 'old rows are not shown as current');
    // The PR list paces its automatic reads (200 ms after the last one).
    await until(() => client.read(prQuery()).status === 'ready', 'the list was not reassembled');
    assert.deepEqual(
      client.read(prQuery()).data?.prs.map((row) => row.title),
      ['changed'],
    );
    assert.equal(reads(), before, 'the pushed row was applied while unobserved: no read');

    client.unwatch();
    gateway.writePR(pr('o/r', 2));
    await flush();
    before = reads();
    client.watch(prQuery());
    await until(() => client.read(prQuery()).status === 'ready', 'the list was not read again');
    assert.deepEqual(
      client.read(prQuery()).data?.prs.map((row) => row.pr),
      [1, 2],
    );
    assert.equal(client.read(prQuery()).status, 'ready');
    assert.equal(reads(), before + 1, 'one versions read for the added PR');
  } finally {
    await client.close();
  }
});

test('C: stored rows that arrive after a gateway change do not refill the discarded view', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('s00', slot('s00'));
  const seeded = await seededStore(gateway, [
    {
      collection: FLEET_ROWS_ID,
      id: 's00',
      body: slot('s00'),
      version: versionOf(slot('s00')),
      data: {},
    },
  ]);
  // The first read of the stored rows is held, as a slow store holds it.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holds = 1;
  const store: ResourceStore = {
    ...seeded,
    getRows: async (id) => {
      if (holds-- > 0) await held;
      return seeded.getRows!(id);
    },
  };
  const client = setup(gateway, store);
  try {
    client.watch(fleetQuery);
    await flush();

    // The gateway is rolled back while the store read is outstanding: a full read shows 26 slots.
    gateway.setConnection({ connected: false });
    await flush();
    for (const row of [...manySlots('main'), slot('s25')]) gateway.slots.set(row.slot, row);
    gateway.reconnect('epoch-2', false);
    await flush();
    assert.equal(client.read(fleetQuery).data?.fleet.slots.length, 26);
    const shown = client.states.length;
    release();
    await flush();

    // It is rolled forward again while every slot changed.
    gateway.setConnection({ connected: false });
    await flush();
    for (const row of [...manySlots('moved'), slot('s25', { branch: 'moved' })])
      gateway.slots.set(row.slot, row);
    gateway.reconnect('epoch-3', true);
    await flush();
    assert.equal(
      slotsOf(client.read(fleetQuery)).filter((row) => row.endsWith(':moved')).length,
      26,
    );
    const counts = client.states
      .slice(shown)
      .map((state: ResourceQueryState<FleetStatusResult>) => state.data?.fleet.slots.length);
    assert.ok(
      counts.every((count) => count === 26),
      `no state shows fewer rows than the full read did (got ${JSON.stringify(counts)})`,
    );
    assert.equal(
      gateway.requests('fleet.status', 'versions').length,
      1,
      'the cancelled read sent no versions read to the gateway without entity sync',
    );
  } finally {
    await client.close();
  }
});

test('G: pushed slots write their rows, and the whole view at most once per pace', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const gateway = new EntityGateway();
  for (const row of manySlots('main')) gateway.slots.set(row.slot, row);
  const memory = createMemoryResourceStore();
  await memory.setMetadata({
    scope: gateway.connection.scope,
    authority: gateway.connection.authority!,
  });
  let views = 0;
  let rows = 0;
  const store: ResourceStore = {
    ...memory,
    persistent: true,
    putQuery: async (entry) => {
      if (entry.id === fleetQuery.id) views++;
      return memory.putQuery(entry);
    },
    mergeRows: async (id, merge) => {
      rows += merge.upserts.length;
      return memory.mergeRows!(id, merge);
    },
  };
  const client = setup(gateway, store);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(views, 1, 'the view read from the gateway is stored');
    rows = 0;

    for (let i = 0; i < 5; i++) {
      gateway.writeSlot(slot('s03', { branch: `push-${i}` }));
      await flush();
    }
    assert.equal(slotsOf(client.read(fleetQuery))[3], 's03:push-4');
    assert.equal(rows, 5, 'each pushed row is stored');
    assert.equal(views, 1, 'the whole view is not stored again for each push');

    // After the pace the next push stores the view once, so an offline start stays recent.
    t.mock.timers.tick(10_000);
    gateway.writeSlot(slot('s03', { branch: 'later' }));
    await flush();
    assert.equal(views, 2);
    const stored = await memory.getQuery<FleetStatusResult>(fleetQuery.id);
    assert.equal(stored?.data.fleet.slots[3].branch, 'later');
  } finally {
    await client.close();
  }
});

test('a pushed machine sample updates host load with no read', async () => {
  const gateway = new EntityGateway();
  gateway.slots.set('a', slot('a', { machine: 'mac-a' }));
  gateway.machines.set('mac-a', machine('mac-a', 10));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).data?.fleet.slots[0].hostLoad?.cpuPercent, 10);
    const before = gateway.log.length;
    gateway.writeMachine(machine('mac-a', 77));
    await flush();
    const fleet = client.read(fleetQuery).data?.fleet;
    assert.equal(fleet?.slots[0].hostLoad?.cpuPercent, 77);
    assert.equal(fleet?.machines?.[0].system?.cpuPercent, 77);
    assert.equal(gateway.log.length, before);
    assert.equal(client.read(fleetQuery).status, 'ready');
  } finally {
    await client.close();
  }
});

test('a gateway without entity sync keeps the full read', async () => {
  const gateway = new EntityGateway({ entitySync: false });
  gateway.slots.set('a', slot('a'));
  const client = setup(gateway);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(gateway.requests('fleet.status', 'full').length, 1);
    assert.equal(gateway.log.length, 1);
    gateway.writeSlot(slot('a', { branch: 'x' }));
    await flush();
  } finally {
    await client.close();
  }
});

test('F4: slots named by version only cost no read when held and one ids read when older', async () => {
  const gateway = new EntityGateway();
  for (const row of manySlots('main')) gateway.slots.set(row.slot, row);
  const client = setup(gateway);
  // A gateway start or a bulk change names every slot by its version, without a body.
  const nameEverySlot = () =>
    gateway.publish(
      [...gateway.slots.values()].map((row) => ({
        key: { family: 'slot' as const, slotId: row.slot },
        changedEntity: { family: 'slot' as const, version: versionOf(row) },
      })),
    );
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    const before = gateway.log.length;

    nameEverySlot();
    await flush();
    assert.equal(gateway.log.length, before, 'every version is held: no read');
    assert.equal(client.read(fleetQuery).status, 'ready');

    for (const id of ['s03', 's04', 's05']) gateway.slots.set(id, slot(id, { branch: 'bulk' }));
    nameEverySlot();
    await flush();
    assert.deepEqual(
      gateway.log.slice(before).map((entry) => entry.params.ids),
      [['s03', 's04', 's05']],
      'one ids read for the slots that changed, and nothing else',
    );
    assert.deepEqual(slotsOf(client.read(fleetQuery)).slice(3, 6), [
      's03:bulk',
      's04:bulk',
      's05:bulk',
    ]);
  } finally {
    await client.close();
  }
});

test('a cold start with unchanged slot versions reads no slot bodies', async () => {
  const gateway = new EntityGateway();
  const rows: SlotEntity[] = [slot('a'), slot('b')];
  for (const row of rows) gateway.slots.set(row.slot, row);
  const store = await seededStore(
    gateway,
    rows.map((row) => ({
      collection: FLEET_ROWS_ID,
      id: row.slot,
      body: row,
      version: versionOf(row),
      data: {},
    })),
  );
  const client = setup(gateway, store);
  try {
    client.watch(fleetQuery);
    await flush();
    assert.equal(client.read(fleetQuery).status, 'ready');
    assert.equal(gateway.requests('fleet.status', 'versions').length, 1);
    assert.equal(gateway.requests('fleet.status', 'ids').length, 0);
  } finally {
    await client.close();
  }
});
