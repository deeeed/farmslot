import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, type Run } from '@farmslot/protocol';

import { withRunSettlementLane } from './broadcast-lanes.js';

const RUN = { id: 'run_1', status: 'done', workGraphId: 'graph-1' } as Run;

test('the settlement lane drives settlement for run events, and only for those', () => {
  const published: string[] = [];
  const settled: string[] = [];
  const withLane = withRunSettlementLane(
    (event) => void published.push(event),
    (run) => void settled.push(run.id),
  );

  withLane(Events.RUN_UPDATED, { run: RUN });
  withLane(Events.RUN_COMPLETED, { run: RUN });
  withLane(Events.FLEET_UPDATED, { fleet: {} });
  // A run event with no run in the payload settles nothing rather than throwing.
  withLane(Events.RUN_UPDATED, {});

  assert.deepEqual(settled, ['run_1', 'run_1']);
  assert.deepEqual(published, [
    Events.RUN_UPDATED,
    Events.RUN_COMPLETED,
    Events.FLEET_UPDATED,
    Events.RUN_UPDATED,
  ]);
});

test('the base broadcaster settles nothing on its own', () => {
  // This is the distinction the engine relies on (ADR-053). A terminal publish
  // the transition router owns goes out on the BASE broadcaster: the router
  // settles the backlog and ticks the work graph itself, awaited and ordered,
  // and repairs a failed settle with a durable marker. Publishing it through
  // the lane started a second, unordered copy of that work — a scheduler tick
  // against a projection whose persistence was still in flight.
  const published: string[] = [];
  const settled: string[] = [];
  const base = (event: string) => void published.push(event);
  const withLane = withRunSettlementLane(base, (run) => void settled.push(run.id));

  base(Events.RUN_COMPLETED, { run: RUN });
  assert.deepEqual(settled, [], 'the base lane must not settle');
  assert.deepEqual(published, [Events.RUN_COMPLETED], 'but it still reaches every client');

  // And the wrapped one still does, so nothing that relied on it lost its settle.
  withLane(Events.RUN_COMPLETED, { run: RUN });
  assert.deepEqual(settled, ['run_1']);
});
