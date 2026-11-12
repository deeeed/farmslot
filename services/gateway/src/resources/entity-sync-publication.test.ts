// Publication of entity-sync changes (ADR-071 Amendment 3): every per-entity change names its
// version; the body rides along only when it changed and fits; collection keys carry a marker.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceKey } from '@farmslot/protocol/client-cache';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

const { GatewayResourceRevisions } = await import('./revisions.js');

/** The protocol's CHANGED_ENTITY_MAX_BYTES. */
const CHANGED_ENTITY_MAX_BYTES = 16 * 1024;

const machineKey: ResourceKey = { family: 'node', nodeId: 'mac-a' };
const collectionKey: ResourceKey = { family: 'slots', scope: 'farm' };

function harness() {
  const revisions = new GatewayResourceRevisions();
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((payload) => packets.push(payload));
  let snapshot = { version: 'v1', bytes: 100 };
  revisions.setEntityProvider('node', (key) =>
    key.family === 'node' && 'nodeId' in key
      ? {
          family: 'node',
          version: snapshot.version,
          bytes: snapshot.bytes,
          entity: { machine: key.nodeId, online: true, headroom: 'green' },
        }
      : undefined,
  );
  revisions.registerEntityCollection(
    (key) => key.family === 'slots' && Object.keys(key).length === 2,
  );
  return {
    revisions,
    packets,
    set(next: { version: string; bytes: number }) {
      snapshot = next;
    },
    async next() {
      await Promise.resolve();
      return packets.shift()?.changes[0];
    },
  };
}

test('a changed entity rides on its notification; an unchanged one is named by version only', async (t) => {
  const { revisions, next, set } = harness();
  t.after(() => revisions.dispose());
  revisions.advance(machineKey);
  const first = await next();
  assert.equal(first?.changedEntity?.version, 'v1');
  assert.ok(first?.changedEntity?.entity, 'the first notification carries the body');

  revisions.advance(machineKey);
  const repeat = await next();
  assert.deepEqual(
    repeat?.changedEntity,
    { family: 'node', version: 'v1' },
    'same version: no body',
  );

  set({ version: 'v2', bytes: 100 });
  revisions.advance(machineKey);
  assert.ok((await next())?.changedEntity?.entity, 'a new version carries its body');
});

test('a body larger than the bound is never attached', async (t) => {
  const { revisions, next, set } = harness();
  t.after(() => revisions.dispose());
  set({ version: 'big', bytes: CHANGED_ENTITY_MAX_BYTES + 1 });
  revisions.advance(machineKey);
  assert.deepEqual((await next())?.changedEntity, { family: 'node', version: 'big' });
});

test('a deletion carries no entity and forgets the published version', async (t) => {
  const { revisions, next } = harness();
  t.after(() => revisions.dispose());
  revisions.advance(machineKey);
  await next();
  revisions.advance(machineKey, 'deleted');
  assert.equal((await next())?.changedEntity, undefined);
  revisions.advance(machineKey);
  assert.ok((await next())?.changedEntity?.entity, 'a re-added entity carries its body again');
});

test('an entity collection key always carries its membership marker', async (t) => {
  const { revisions, next } = harness();
  t.after(() => revisions.dispose());
  revisions.advance(collectionKey);
  assert.equal((await next())?.membershipRevision, 0, 'before any membership change');
  revisions.advanceMembership(collectionKey);
  assert.equal((await next())?.membershipRevision, 1);
  assert.equal(revisions.membershipRevision(collectionKey), 1);
  revisions.advance({ family: 'slots', scope: 'farm', project: 'demo' });
  assert.equal(
    (await next())?.membershipRevision,
    undefined,
    'other collection keys are not entity collections',
  );
});
