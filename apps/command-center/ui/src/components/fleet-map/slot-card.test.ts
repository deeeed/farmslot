import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotStatus, SlotWorkspace } from '@farmslot/protocol';

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

function observed(overrides: Partial<SlotWorkspace> = {}): SlotWorkspace {
  return {
    epoch: 1,
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    branch: 'feat/demo',
    headSha: 'abc',
    dirtyFingerprint: '',
    recoveryId: null,
    observedAt: new Date().toISOString(),
    localDefaultSha: 'abc',
    defaultFetchedAt: null,
    remoteDefaultSha: null,
    remoteObservedAt: null,
    behind: 4,
    remoteAdvanced: false,
    publication: 'pushed',
    dirtyCount: 0,
    unpublishedCount: 0,
    ...overrides,
  };
}

test('a current workspace observation shows how far the slot is behind main', () => {
  const text = cardText(idleSlot({ branch: 'feat/demo', workspace: observed() }));
  assert.match(text, /feat\/demo/);
  assert.match(text, /4 behind main/);
  assert.doesNotMatch(text, /unknown|Unowned/i);
});

test('an expired or unknown observation shows no distance, as the release review does', () => {
  for (const workspace of [
    observed({ observedAt: '2000-01-01T00:00:00.000Z' }),
    observed({ publication: 'unknown' }),
  ]) {
    const text = cardText(idleSlot({ branch: 'feat/demo', workspace }));
    assert.doesNotMatch(text, /\d+ behind|unknown/i);
  }
});

test('the distance arriving fills a reserved line instead of adding one', () => {
  const lines = (slot: SlotStatus) => cardText(slot).match(/<div/g)?.length ?? 0;
  assert.equal(lines(idleSlot({ workspace: observed() })), lines(idleSlot()));
});

test('cards carry no per-slot release button; the table owns the bulk release', () => {
  assert.doesNotMatch(cardText(idleSlot()), /Release and update to main|Inspect workspace/);
});
