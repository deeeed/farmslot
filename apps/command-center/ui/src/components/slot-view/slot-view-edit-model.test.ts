import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { Run, SlotStatus } from '@farmslot/protocol';

import {
  slotConditionalWrites,
  slotViewAutosaveAllowed,
  slotViewDraftState,
  slotViewGateWarning,
  slotViewReadOnlyReason,
  slotViewSaveRefusal,
} from './slot-view-edit-model.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('the editor is read-only, with its reason, unless every editing condition holds', () => {
  const content = 'export const value = 1;\n';
  const ready = {
    connected: true,
    capability: true,
    host: true,
    ready: true,
    content,
    hash: sha256(content),
  };
  assert.equal(slotViewReadOnlyReason(ready), undefined);
  assert.equal(slotViewReadOnlyReason({ ...ready, connected: false }), 'offline');
  assert.equal(slotViewReadOnlyReason({ ...ready, capability: false }), 'capability');
  assert.equal(slotViewReadOnlyReason({ ...ready, host: false }), 'host');
  assert.equal(slotViewReadOnlyReason({ ...ready, staleRun: true }), 'stale-run');
  assert.equal(slotViewReadOnlyReason({ ...ready, ready: false }), 'hash', 'a stale read is shown');
  assert.equal(
    slotViewReadOnlyReason({ ...ready, hash: undefined }),
    'hash',
    'old reads carry none',
  );
  // Text that does not re-encode to the read bytes, such as a non-UTF-8 file, stays read-only.
  assert.equal(slotViewReadOnlyReason({ ...ready, hash: sha256('other bytes') }), 'encoding');
});

test('local slots and nodes that advertise conditional writes are the hosts that check edits', () => {
  const remote = { machine: 'mini', health: { ssh: 'OK' } } as SlotStatus;
  const local = { machine: 'mac', health: { ssh: 'LOCAL' } } as SlotStatus;
  assert.equal(slotConditionalWrites(local, undefined), true);
  assert.equal(slotConditionalWrites(remote, [{ machine: 'mini', conditionalWrites: true }]), true);
  assert.equal(slotConditionalWrites(remote, [{ machine: 'mini' }]), false);
  assert.equal(
    slotConditionalWrites(remote, [{ machine: 'other', conditionalWrites: true }]),
    false,
  );
  assert.equal(slotConditionalWrites(remote, undefined), false);
  assert.equal(slotConditionalWrites(null, undefined), false);
});

test('autosave runs only on a current, non-busy slot record for a draft armed by typing', () => {
  const allowed = { fleetCurrent: true, slot: { lifecycle: 'ready' as const }, armed: true };
  assert.equal(slotViewAutosaveAllowed(allowed), true);
  assert.equal(slotViewAutosaveAllowed({ ...allowed, slot: { lifecycle: 'held' } }), true);
  assert.equal(slotViewAutosaveAllowed({ ...allowed, slot: { lifecycle: 'busy' } }), false);
  assert.equal(slotViewAutosaveAllowed({ ...allowed, fleetCurrent: false }), false);
  assert.equal(slotViewAutosaveAllowed({ ...allowed, slot: undefined }), false);
  assert.equal(
    slotViewAutosaveAllowed({ ...allowed, armed: false }),
    false,
    'restored drafts wait',
  );
});

test('a pending gate warns that a save needs a new review', () => {
  const gated = {
    decisions: [{ type: 'engine_human_gate', payload: { kind: 'ready' } }],
  } as unknown as Run;
  const resolved = {
    decisions: [{ type: 'engine_human_gate', resolvedAt: '2026-10-27T00:00:00Z' }],
  } as unknown as Run;
  assert.equal(slotViewGateWarning(gated, { phase: 'working' } as SlotStatus), true);
  assert.equal(slotViewGateWarning(null, { phase: 'review-gate' } as SlotStatus), true);
  assert.equal(slotViewGateWarning(resolved, { phase: 'working' } as SlotStatus), false);
  assert.equal(slotViewGateWarning(null, null), false);
});

test('a draft is hidden for an unreadable slot and read-only once its run is not current', () => {
  const fleet = {
    ready: true,
    slots: [{ slot: 'slot-a', currentRunId: 'run-2' }] as SlotStatus[],
  };
  const draft = { slotId: 'slot-a', runId: 'run-2' };
  assert.equal(slotViewDraftState(draft, fleet, new Set()), 'current');
  assert.equal(slotViewDraftState({ ...draft, runId: 'run-1' }, fleet, new Set()), 'stale-run');
  assert.equal(slotViewDraftState({ ...draft, runId: null }, fleet, new Set()), 'stale-run');
  assert.equal(slotViewDraftState({ ...draft, slotId: 'gone' }, fleet, new Set()), 'hidden');
  assert.equal(slotViewDraftState(draft, fleet, new Set(['slot-a'])), 'hidden', 'read refused');
  assert.equal(slotViewDraftState(draft, { ...fleet, ready: false }, new Set()), undefined);
});

test('save refusals name a changed file, another run, an existing destination or an old node', () => {
  const refusal = (code: string, details?: unknown) =>
    slotViewSaveRefusal(Object.assign(new Error('refused'), { code, details }));
  assert.deepEqual(refusal('FS_CONFLICT', { reason: 'hash', currentHash: 'abc' }), {
    kind: 'hash',
    currentHash: 'abc',
  });
  assert.deepEqual(refusal('FS_CONFLICT', { reason: 'hash' }), { kind: 'hash', currentHash: null });
  assert.deepEqual(refusal('FS_CONFLICT', { reason: 'run', currentRunId: 'run-9' }), {
    kind: 'run',
    currentRunId: 'run-9',
  });
  assert.deepEqual(refusal('FS_CONFLICT', { reason: 'run', currentRunId: null }), {
    kind: 'run',
    currentRunId: null,
  });
  assert.deepEqual(refusal('FS_CONFLICT', { reason: 'destination-exists' }), {
    kind: 'destination-exists',
  });
  assert.deepEqual(refusal('FS_PRECONDITION_UNSUPPORTED'), { kind: 'unsupported' });
  assert.equal(refusal('NOT_CONNECTED'), undefined);
});
