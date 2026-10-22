import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceChangedPayload } from '@farmslot/protocol';

import { GatewayResourceRevisions } from './revisions.js';
import { SlotResourceChanges, statusSlotResources } from './slot-run-bindings.js';

test('membership and pointer changes include former members, while identical observations stay quiet', async () => {
  const revisions = new GatewayResourceRevisions();
  const bindings = new SlotResourceChanges(revisions);
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  const rows = [{ slot: 'first', current_run_id: 'before' }, { slot: 'removed' }];
  try {
    bindings.observe(statusSlotResources({ slots: rows }));
    const first = revisions.revision({ family: 'runs', scope: 'farm' });
    bindings.observe(statusSlotResources({ slots: rows.map((row) => ({ ...row })) }));
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), first);
    // Retaining a caller's mutable rows would miss this change.
    rows[0].current_run_id = 'after';
    bindings.observe(
      statusSlotResources({ slots: [rows[0], { slot: 'new', current_run_id: null }] }),
    );
    await Promise.resolve();
    for (const family of ['runs', 'slots', 'decisions'] as const)
      assert.equal(revisions.revision({ family, scope: 'farm' }), first + 1);
    assert.equal(revisions.revision({ family: 'slot', slotId: 'first' }), 2);
    assert(
      packets
        .flatMap((packet) => packet.changes)
        .some(
          ({ key, kind }) =>
            key.family === 'slot' && key.slotId === 'removed' && kind === 'deleted',
        ),
    );
    assert.equal(revisions.revision({ family: 'slot', slotId: 'new' }), 1);
    bindings.unavailable();
    bindings.unavailable();
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), first + 2);
    bindings.observe(
      statusSlotResources({ slots: [rows[0], { slot: 'new', current_run_id: null }] }),
    );
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), first + 3);
  } finally {
    revisions.dispose();
  }
});

test('malformed or ambiguous status bindings cannot become an authoritative snapshot', () => {
  for (const value of [
    null,
    {},
    { slots: {} },
    { slots: [null] },
    { slots: [{ slot: 'a', current_run_id: 3 }] },
    { slots: [{ slot: 'a' }, { slot: 'a', current_run_id: 'different' }] },
  ])
    assert.throws(() => statusSlotResources(value), /fleet|Fleet/);
  assert.deepEqual(
    statusSlotResources({ slots: [{ slot: 'a' }, { slot: 'b', current_run_id: 'run' }] }).map(
      ({ slot, currentRunId }) => ({ slot, currentRunId }),
    ),
    [
      { slot: 'a', currentRunId: null },
      { slot: 'b', currentRunId: 'run' },
    ],
  );
});

test('slot facts invalidate their detail and former scopes without refetching unchanged run bindings', () => {
  const revisions = new GatewayResourceRevisions();
  const slots = new SlotResourceChanges(revisions);
  const rows = [
    {
      slot: 'slot-a',
      current_run_id: 'retained-run',
      project: 'first-project',
      machine: 'first-node',
      lifecycle: 'ready',
      branch: 'before',
    },
  ];
  const observe = () => slots.observe(statusSlotResources({ slots: rows }));
  try {
    observe();
    const collection = revisions.revision({ family: 'slots', scope: 'farm' });
    const runs = revisions.revision({ family: 'runs', scope: 'farm' });
    rows[0].lifecycle = 'busy';
    rows[0].branch = 'after';
    observe();
    assert.equal(revisions.revision({ family: 'slots', scope: 'farm' }), collection + 1);
    assert.equal(revisions.revision({ family: 'slot', slotId: 'slot-a' }), 2);
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), runs);
    observe();
    assert.equal(revisions.revision({ family: 'slots', scope: 'farm' }), collection + 1);
    rows[0].project = 'next-project';
    rows[0].machine = 'next-node';
    observe();
    for (const project of ['first-project', 'next-project'])
      assert(revisions.revision({ family: 'slots', scope: 'farm', project }) > 0);
    for (const nodeId of ['first-node', 'next-node'])
      assert(revisions.revision({ family: 'slots', scope: 'farm', nodeId }) > 0);
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), runs);
    slots.observe(statusSlotResources({ slots: [] }));
    assert.equal(revisions.revision({ family: 'slot', slotId: 'slot-a' }), 4);
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), runs + 1);
  } finally {
    revisions.dispose();
  }
});

test('failed slot reads invalidate known details once and recovery republishes unchanged facts', () => {
  const revisions = new GatewayResourceRevisions();
  const slots = new SlotResourceChanges(revisions);
  const snapshot = () =>
    statusSlotResources({ slots: [{ slot: 'retained', current_run_id: 'same-run' }] });
  try {
    slots.observe(snapshot());
    slots.unavailable();
    assert.equal(revisions.revision({ family: 'slot', slotId: 'retained' }), 2);
    slots.unavailable();
    assert.equal(revisions.revision({ family: 'slot', slotId: 'retained' }), 2);
    slots.observe(snapshot());
    assert.equal(revisions.revision({ family: 'slot', slotId: 'retained' }), 3);
    slots.observe(snapshot());
    assert.equal(revisions.revision({ family: 'slot', slotId: 'retained' }), 3);
  } finally {
    revisions.dispose();
  }
});

test('bursts publish only resource keys and the latest slot revision', async () => {
  const revisions = new GatewayResourceRevisions();
  const slots = new SlotResourceChanges(revisions);
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  try {
    for (let step = 0; step < 50; step++)
      slots.observe(
        statusSlotResources({
          slots: [
            {
              slot: 'busy-slot',
              project: 'project-id',
              machine: 'node-id',
              repo: '/private/worktree-path',
              task_phase: `private phase ${step}`,
            },
          ],
        }),
      );
    await Promise.resolve();
    const details = packets
      .flatMap((packet) => packet.changes)
      .filter(({ key }) => key.family === 'slot');
    assert.equal(details.length, 1);
    assert.equal(details[0].revision, 50);
    assert.doesNotMatch(JSON.stringify(packets), /private phase|worktree-path|fingerprint/);
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), 1);
  } finally {
    revisions.dispose();
  }
});
