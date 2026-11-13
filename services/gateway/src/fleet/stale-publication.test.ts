// The fleet's stale state reaches entity-sync clients: production bindings, revisions and slot
// entities, read by the client's own fleet view. Alone in its file: the observed read starts
// workspace inspections that reload the status file in the background.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

const { setCachedFleetForTests, loadFleetStatus, statusFile } = await import('./state.js');
const { fleetStatusIds, fleetStatusVersions } = await import('./slot-entities.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { slotResourceChanges, statusSlotResources } =
  await import('../resources/slot-run-bindings.js');
const { fleetStatus } = await import('../methods/fleet.js');
const { fleetStaleThresholdMs } = await import('./freshness.js');
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
  /** A connected client: every publication reaches its view, which reads only what that calls for. */
  const connect = () => {
    const client = createFleetEntityView();
    const stop = resourceRevisions.subscribe((payload) => {
      for (const change of payload.changes) client.applyChange(change);
    });
    t.after(stop);
    return client;
  };
  const view = connect();
  /** The client's sync; `during` runs once the versions read has started. */
  const reads = async (client = view, during?: () => void) => {
    for (let turn = 0; turn < 3; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    let versions = 0;
    let ids = 0;
    await client.sync(async (params) => {
      const requested =
        params && typeof params === 'object' ? Reflect.get(params, 'ids') : undefined;
      if (Array.isArray(requested)) {
        ids++;
        return fleetStatusIds(requested);
      }
      versions++;
      const reply = fleetStatusVersions();
      during?.();
      return reply;
    });
    return [versions, ids];
  };
  const follow = async (label: string, stale: boolean, cost?: number[], client = view) => {
    const spent = await reads(client);
    // The first read's cost depends on what the pushes already carried.
    if (cost) assert.deepEqual(spent, cost, `${label}: [versions, ids] reads`);
    const full = await fullRead();
    // Compared as sent; an empty machine list and an absent one both mean no machine health.
    const sent = (value: unknown) =>
      JSON.parse(JSON.stringify(value), (key, field: unknown) =>
        key === 'machines' && Array.isArray(field) && !field.length ? undefined : field,
      );
    assert.deepEqual(
      sent(client.answer()?.data),
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
  t.mock.timers.tick(fleetStaleThresholdMs() + 1);
  await follow('the deadline', true, [1, 0]);
  t.mock.timers.setTime(Date.now() - 10 * 60_000);
  commit(now());
  await follow('recovery after the clock moved back', false, [1, 0]);

  // The deadline publishes stale, then the clock moves back with no commit: the first fresh read
  // tells clients.
  t.mock.timers.tick(fleetStaleThresholdMs() + 1);
  await follow('the deadline before a rollback', true, [1, 0]);
  t.mock.timers.setTime(Date.now() - 10 * 60_000);
  assert.equal((await fullRead()).fleet.stale, undefined, 'a fresh full read, no commit');
  assert.deepEqual(await reads(), [1, 0], 'the client is told by that read');
  await follow('recovery without a commit', false, [0, 0]);

  // A versions read past the threshold before the deadline timer runs: the read itself tells every
  // client, so the next fresh commit is a change for all of them. Versions reads only here: a full
  // read tells clients by itself.
  t.mock.timers.setTime(Date.now() + fleetStaleThresholdMs() + 1);
  const late = connect();
  await reads(late);
  assert.match(JSON.stringify(late.answer()?.data), /"stale":true/, 'a new client reads stale');
  assert.deepEqual(await reads(), [1, 0], 'the connected client is told by that read');
  commit(now());
  await follow('recovery reaches the client that read first', false, [1, 0], late);
  await follow('and the connected client', false, [1, 0]);

  // A full read past the threshold before the timer runs tells entity-sync clients too.
  t.mock.timers.setTime(Date.now() + fleetStaleThresholdMs() + 1);
  assert.equal((await fullRead()).fleet.stale, true);
  await follow('a full read before the timer', true, [1, 0]);
  commit(now());
  await follow('its recovery', false, [1, 0]);

  // A commit lands at any point of a versions read, in both directions: the reply describes one
  // state, and the client converges on the full read.
  const atDepth = (depth: number, run: () => void): void => {
    if (depth === 0) run();
    else queueMicrotask(() => atDepth(depth - 1, run));
  };
  for (let depth = 0; depth < 8; depth++) {
    for (const [label, from, to, stale] of [
      ['stale', now(), '2000-01-01T00:00:00.000Z', true],
      ['fresh', '2000-01-01T00:00:00.000Z', now(), false],
    ] as const) {
      commit(from);
      // A new client: its first sync is a versions read, with the commit landing during it.
      const reader = connect();
      await reads(reader, () => atDepth(depth, () => commit(to)));
      await follow(
        `a ${label} commit at depth ${depth} of a versions read`,
        stale,
        undefined,
        reader,
      );
    }
  }

  // The source becomes unreadable, as a failed status commit reports it: the client is told, its
  // versions read fails with the source error, then it recovers to a stale and to a fresh snapshot.
  commit(now());
  await follow('fresh before the source fails', false);
  const saved = await readFile(statusFile, 'utf8');
  t.after(() => writeFile(statusFile, saved));
  await writeFile(statusFile, '{');
  setCachedFleetForTests(null);
  slotResourceChanges.unavailable();
  await assert.rejects(reads(), SyntaxError, 'the read reports the source error');
  await writeFile(statusFile, saved);
  commit('2000-01-01T00:00:00.000Z');
  await follow('recovery to a stale snapshot', true, [1, 0]);
  commit(now());
  await follow('and to a fresh one', false, [1, 0]);
});
