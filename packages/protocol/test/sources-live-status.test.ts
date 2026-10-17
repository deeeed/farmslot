import assert from 'node:assert/strict';
import test from 'node:test';

import type { SourcesStatusResult } from '../src/rpc/sources.js';
import { createSourceChangeFeed, sourceResourceChanges } from '../src/sources/changes.js';
import { createSourceCommandClient } from '../src/sources/client.js';
import { SourceStatusController } from '../src/sources/controller.js';
import { Events } from '../src/transport/events.js';

import { sourceStatusFixture } from './fixtures/source-status.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const changes = (revision: number, epoch = 'epoch-1') => ({
  resourceChanges: {
    version: 1,
    epoch,
    changes: [{ key: { family: 'sources', scope: 'farm' }, revision, kind: 'updated' }],
  },
});

/** A farm panel whose reads return whatever `next` holds when each read starts. */
function harness() {
  let next: () => Promise<SourcesStatusResult> = async () => sourceStatusFixture();
  let reads = 0;
  const client = createSourceCommandClient(async <T>(): Promise<T> => {
    reads++;
    return (await next()) as T;
  });
  const controller = new SourceStatusController(client, {
    target: { scope: 'farm', targetId: 'farm' },
    actions: ['pin', 'unpin'],
  });
  const feed = createSourceChangeFeed();
  controller.attachFeed(feed);
  return {
    controller,
    feed,
    reads: () => reads,
    respond(responder: () => Promise<SourcesStatusResult>) {
      next = responder;
    },
  };
}

test('a pin changed by another client reaches an open panel without user action', async () => {
  const panel = harness();
  panel.feed.receive(Events.HELLO, { fleet: null, ...changes(4) });
  await panel.controller.refresh();
  assert.equal(panel.reads(), 1);
  assert.equal(panel.controller.getSnapshot().view?.line, 'pack experiment');

  panel.respond(async () => {
    const status = sourceStatusFixture();
    status.pinRevision = 3;
    status.effectiveSelections![0].effectiveRef = 'main';
    return status;
  });
  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(5) });
  await settle();
  assert.equal(panel.reads(), 2);
  assert.equal(panel.controller.getSnapshot().view?.line, 'pack main');

  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(5) });
  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(4) });
  await settle();
  assert.equal(panel.reads(), 2, 'duplicate and older revisions are ignored');

  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(1, 'epoch-2') });
  await settle();
  assert.equal(panel.reads(), 3, 'a new gateway epoch rereads even with a lower revision');
});

test('a change during an in-flight read schedules exactly one more read', async () => {
  const panel = harness();
  panel.feed.receive(Events.HELLO, { fleet: null, ...changes(1) });
  await panel.controller.refresh();
  let release!: () => void;
  panel.respond(
    () =>
      new Promise((resolve) => {
        release = () => resolve(sourceStatusFixture());
      }),
  );
  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(2) });
  await settle();
  assert.equal(panel.reads(), 2);
  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(3) });
  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(4) });
  await settle();
  assert.equal(panel.reads(), 2, 'the in-flight read is not abandoned');
  panel.respond(async () => sourceStatusFixture());
  release();
  await settle();
  await settle();
  assert.equal(panel.reads(), 3);
});

test('a change while a failed read is shown rereads, and denied reads hide the panel', async () => {
  const panel = harness();
  panel.feed.receive(Events.HELLO, { fleet: null, ...changes(1) });
  panel.respond(async () => {
    throw new Error('Execution node is disconnected');
  });
  await panel.controller.refresh();
  assert.equal(panel.controller.getSnapshot().error, 'Execution node is disconnected');
  assert.equal(panel.controller.getSnapshot().hidden, false);
  panel.respond(async () => sourceStatusFixture());
  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(2) });
  await settle();
  assert.equal(panel.controller.getSnapshot().error, undefined);
  assert(panel.controller.getSnapshot().view);

  panel.respond(async () => {
    throw Object.assign(new Error('Denied: sources.status requires admin'), {
      code: 'AUTH_FORBIDDEN',
    });
  });
  await panel.controller.refresh();
  assert.equal(panel.controller.getSnapshot().hidden, true);
});

test('an empty context is hidden and a gateway that does not announce is unsupported', async () => {
  const panel = harness();
  panel.respond(async () => ({
    ...sourceStatusFixture(),
    configured: false,
    declarations: [],
    locks: [],
    effectiveSelections: [],
  }));
  panel.feed.receive(Events.HELLO, { fleet: null });
  await panel.controller.refresh();
  assert.equal(panel.controller.getSnapshot().hidden, true);
  assert.equal(
    panel.controller.getSnapshot().unsupported,
    false,
    'unconfigured is not unsupported',
  );

  panel.respond(async () => sourceStatusFixture());
  await panel.controller.refresh();
  assert.equal(panel.controller.getSnapshot().hidden, false);
  assert.equal(panel.controller.getSnapshot().unsupported, true);
});

test('reconnect starts a new announcement; the host reread then sees live status again', async () => {
  const panel = harness();
  panel.feed.receive(Events.HELLO, { fleet: null });
  await panel.controller.refresh();
  assert.equal(panel.controller.getSnapshot().unsupported, true);
  panel.feed.disconnected();
  assert.equal(panel.feed.getState().announced, undefined);
  panel.feed.receive(Events.HELLO, { fleet: null, ...changes(7) });
  // Hosts reread on every new connection; that read covers revision 7.
  await panel.controller.refresh();
  assert.equal(panel.controller.getSnapshot().unsupported, false);
  const before = panel.reads();
  panel.feed.receive(Events.FLEET_UPDATED, { fleet: {}, ...changes(7) });
  await settle();
  assert.equal(panel.reads(), before);
});

test('the carrier decoder reads only hello and fleet.updated with a valid payload', () => {
  assert.equal(sourceResourceChanges(Events.RUN_UPDATED, changes(1)), undefined);
  assert.equal(sourceResourceChanges(Events.FLEET_UPDATED, { fleet: {} }), undefined);
  assert.equal(
    sourceResourceChanges(Events.FLEET_UPDATED, {
      resourceChanges: { version: 2, epoch: 'e', changes: [] },
    }),
    undefined,
  );
  assert.deepEqual(sourceResourceChanges(Events.HELLO, changes(3))?.changes[0].revision, 3);
});
