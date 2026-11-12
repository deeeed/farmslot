// The fleet's stale state reaches entity-sync clients: production bindings, revisions and slot
// entities, read by the client's own fleet view. Alone in its file: the observed read starts
// workspace inspections that reload the status file in the background.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

const { setCachedFleetForTests, loadFleetStatus } = await import('./state.js');
const { fleetStatusIds, fleetStatusVersions } = await import('./slot-entities.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { slotResourceChanges, statusSlotResources } =
  await import('../resources/slot-run-bindings.js');
const { fleetStatus } = await import('../methods/fleet.js');
const { createFleetEntityView } =
  await import('../../../../packages/protocol/src/client-cache/entity-views.js');

function slot(id: string): SlotStatus {
  return {
    slot: id,
    machine: 'mac-a',
    platform: 'macos',
    project: 'demo',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
}

function fleetOf(checkedAt: string): FleetStatus {
  const slots = [slot('a'), slot('b')];
  return {
    checkedAt,
    slots,
    summary: {
      total: slots.length,
      ready: slots.length,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

test('an entity-sync client follows every stale state change with one versions read', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-06-01T00:00:00Z') });
  t.after(() => setCachedFleetForTests(null));
  const rows = { slots: [{ slot: 'a' }, { slot: 'b' }] };
  /** A status commit, as the writer makes it: new rows, then their observation. */
  const commit = (checkedAt: string | undefined) => {
    setCachedFleetForTests(fleetOf(checkedAt ?? ''));
    slotResourceChanges.observe(statusSlotResources(rows), checkedAt);
  };
  /** The full read's answer: the plain read's rule, with no refresh started. */
  const fullRead = () =>
    fleetStatus(undefined, {
      load: () => loadFleetStatus(false, true),
      refresh: async () => ({ fleet: await loadFleetStatus(false, true) }),
      join: async () => ({ fleet: await loadFleetStatus(false, true) }),
    });
  // A connected client: every publication reaches its view, which reads only what that calls for.
  const view = createFleetEntityView();
  const stop = resourceRevisions.subscribe((payload) => {
    for (const change of payload.changes) view.applyChange(change);
  });
  t.after(stop);
  const reads = async () => {
    for (let turn = 0; turn < 3; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    let versions = 0;
    let ids = 0;
    await view.sync(async (params) => {
      const requested =
        params && typeof params === 'object' ? Reflect.get(params, 'ids') : undefined;
      if (Array.isArray(requested)) {
        ids++;
        return fleetStatusIds(requested);
      }
      versions++;
      return fleetStatusVersions();
    });
    return [versions, ids];
  };
  const follow = async (label: string, stale: boolean, cost?: number[]) => {
    const spent = await reads();
    // The first read's cost depends on what the pushes already carried.
    if (cost) assert.deepEqual(spent, cost, `${label}: [versions, ids] reads`);
    const full = await fullRead();
    // Compared as sent; an empty machine list and an absent one both mean no machine health.
    const sent = (value: unknown) =>
      JSON.parse(JSON.stringify(value), (key, field: unknown) =>
        key === 'machines' && Array.isArray(field) && !field.length ? undefined : field,
      );
    assert.deepEqual(
      sent(view.answer()?.data),
      sent(full),
      `${label}: the client's fleet equals the full read`,
    );
    assert.equal(full.fleet.stale, stale ? true : undefined, label);
  };
  const now = () => new Date().toISOString();

  commit(now());
  await follow('first read', false);
  commit(now());
  await follow('a fresh commit', false, [0, 0]);
  commit('2000-01-01T00:00:00.000Z');
  await follow('an already-stale replacement', true, [1, 0]);
  commit(now());
  await follow('its recovery', false, [1, 0]);
  commit(undefined);
  await follow('a missing checked_at', true, [1, 0]);
  commit(now());
  await follow('a repaired checked_at', false, [1, 0]);
  t.mock.timers.tick(5 * 60_000 + 1);
  await follow('the deadline', true, [1, 0]);
  t.mock.timers.setTime(Date.now() - 10 * 60_000);
  commit(now());
  await follow('recovery after the clock moved back', false, [1, 0]);
});
