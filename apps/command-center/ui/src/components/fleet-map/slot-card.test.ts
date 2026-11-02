import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
mock.module('../../state.js', {
  namedExports: { getProjectSlotTrackingConfigs: () => ({}) },
});
const { SlotCard } = await import('./slot-card.js');

function idleSlot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: 'runner-a-1',
    machine: 'runner-a',
    project: 'demo',
    branch: 'main',
    enabled: true,
    lifecycle: 'ready',
    phase: null,
    currentRunId: '',
    agent: 'idle',
    health: { ssh: 'LOCAL', device: '-', devserver: '-', cdp: '-', fixtures: 'OK' },
    ...overrides,
  } as SlotStatus;
}

function cardText(slot: SlotStatus): string {
  const card = new SlotCard();
  card.slotData = slot;
  return litText(card.render()).replace(/\s+/g, ' ');
}

test('an idle slot with no saved workspace shows its branch and no unknown filler', () => {
  const text = cardText(idleSlot());
  assert.match(text, /main/);
  assert.doesNotMatch(text, /unknown|Unowned|Fetch time/i);
});

test('a saved workspace observation shows how far the slot is behind main', () => {
  const text = cardText(
    idleSlot({
      branch: 'feat/demo',
      workspace: {
        epoch: 1,
        currentRunId: null,
        cleanupRunId: null,
        handoffRunId: null,
        branch: 'feat/demo',
        headSha: 'abc',
        dirtyFingerprint: '',
        recoveryId: null,
        observedAt: '2026-11-02T00:00:00.000Z',
        localDefaultSha: 'abc',
        defaultFetchedAt: null,
        remoteDefaultSha: null,
        remoteObservedAt: null,
        behind: 4,
        remoteAdvanced: false,
        publication: 'unknown',
        dirtyCount: 0,
        unpublishedCount: 0,
      },
    }),
  );
  assert.match(text, /feat\/demo/);
  assert.match(text, /4 behind main/);
  assert.doesNotMatch(text, /unknown|Unowned/i);
});

test('cards carry no per-slot release button; the table owns the bulk release', () => {
  assert.doesNotMatch(cardText(idleSlot()), /Release and update to main|Inspect workspace/);
});
