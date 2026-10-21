import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceChangedPayload } from '@farmslot/protocol';

import { GatewayResourceRevisions } from './revisions.js';
import { SlotRunBindingChanges, statusRunBindings } from './slot-run-bindings.js';

test('membership and pointer changes include former members, while identical observations stay quiet', async () => {
  const revisions = new GatewayResourceRevisions();
  const bindings = new SlotRunBindingChanges(revisions);
  const packets: ResourceChangedPayload[] = [];
  revisions.setPublisher((packet) => packets.push(packet));
  const rows = [{ slot: 'first', currentRunId: 'before' }, { slot: 'removed' }];
  try {
    bindings.observe(rows);
    const first = revisions.revision({ family: 'runs', scope: 'farm' });
    bindings.observe(rows.map((row) => ({ ...row })));
    assert.equal(revisions.revision({ family: 'runs', scope: 'farm' }), first);
    // Retaining a caller's mutable rows would miss this change.
    rows[0].currentRunId = 'after';
    bindings.observe([rows[0], { slot: 'new', currentRunId: null }]);
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
    bindings.observe([rows[0], { slot: 'new', currentRunId: null }]);
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
    assert.throws(() => statusRunBindings(value), /fleet|Fleet/);
  assert.deepEqual(
    statusRunBindings({ slots: [{ slot: 'a' }, { slot: 'b', current_run_id: 'run' }] }),
    [
      { slot: 'a', currentRunId: null },
      { slot: 'b', currentRunId: 'run' },
    ],
  );
});
