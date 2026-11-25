// Each Command Center prepare-for-run entry point passes the run's flow type and domain: the load-run
// modal and the prepare popover to runSlotPrepareForRun, and run detail and slot history to the
// popover's attributes.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotRunHistoryEntry } from '@farmslot/protocol';

import { litBinding } from '../../testing/lit-text.js';

mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      resourceConnectionId: 'connection-1',
      connectionState: 'connected',
      request: async () => ({}),
    },
  },
});
const prepares: Array<Record<string, unknown>> = [];
const realClient = await import('./slot-prepare-client.js');
mock.module('./slot-prepare-client.js', {
  namedExports: {
    ...realClient,
    runSlotPrepareForRun: async (input: Record<string, unknown>) => {
      prepares.push(input);
      return { prepared: true, requestId: 'r' };
    },
    navigateToPreparedSlot: () => {},
  },
});

const { SlotPreparePopover } = await import('./slot-prepare-popover.js');
const { SlotLoadRunModal } = await import('../slot-view/slot-load-run-modal.js');
const { SlotHistoryModal } = await import('../slot-view/slot-history-modal.js');
const { renderRunSlotPreparePopover } = await import('../runs/run-slot-prepare-popover.js');

test('the prepare popover sends its run flow type and domain', async () => {
  prepares.length = 0;
  const popover = new SlotPreparePopover();
  Object.assign(popover, {
    slotId: 'slot-1',
    runId: 'run-1',
    runBranch: 'feat/x',
    runFlowType: 'dev',
    runDomain: 'perps',
  });
  Reflect.set(popover, '_open', true);
  Reflect.set(popover, '_confirmScope', Reflect.get(popover, '_scope'));
  await Reflect.get(popover, '_run').call(popover, '', true);
  assert.equal(prepares.length, 1);
  assert.equal(prepares[0]?.flowType, 'dev');
  assert.equal(prepares[0]?.domain, 'perps');
});

test('the load-run modal sends the loaded run flow type and domain', async () => {
  prepares.length = 0;
  const modal = new SlotLoadRunModal();
  const run = { id: 'run-2', branch: 'feat/y', flowType: 'fix-bug', domain: 'perps' } as const;
  Object.assign(modal, { slotId: 'slot-1', slotBranch: 'main' });
  Object.defineProperty(modal, 'isConnected', { value: true });
  Reflect.set(modal, '_currentRun', async () => run);
  await Reflect.get(modal, '_executeLoad').call(modal, run, {
    prepareProfile: '',
    strictProfile: true,
    forcePrepare: false,
  });
  assert.equal(prepares.length, 1);
  assert.equal(prepares[0]?.runId, 'run-2');
  assert.equal(prepares[0]?.flowType, 'fix-bug');
  assert.equal(prepares[0]?.domain, 'perps');
});

test('run detail binds the run flow type and domain on its prepare popover', () => {
  const rendered = renderRunSlotPreparePopover(
    { id: 'run-3', project: 'p', branch: 'feat/z', flowType: 'qa', domain: 'perps' },
    { id: 'slot-1', branch: 'main', health: null },
    false,
  );
  assert.equal(litBinding(rendered, 'run-flow-type='), 'qa');
  assert.equal(litBinding(rendered, 'run-domain='), 'perps');
});

test('slot history binds the run flow type and domain on its prepare popover', () => {
  const modal = new SlotHistoryModal();
  Object.assign(modal, { slotId: 'slot-1', slotBranch: 'main', project: 'p' });
  const entry: SlotRunHistoryEntry = {
    runId: 'run-4',
    familyId: 'run-4',
    status: 'done',
    flowType: 'dev',
    domain: 'perps',
    ticketOrPr: 'TAT-1',
    project: 'p',
    branch: 'feat/w',
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
    runner: null,
    model: null,
    taskFile: null,
    taskDir: null,
    artifactDir: null,
    prNumber: null,
    diffStat: { files: 0, additions: 0, deletions: 0, available: false },
    visualPairCount: 0,
    runRecordPath: '/runs/run-4.json',
    currentForSlot: false,
  };
  // The popover sits in the row's expanded actions.
  Reflect.set(modal, '_expanded', new Set([entry.runId]));
  const rendered = Reflect.get(modal, '_renderRow').call(modal, entry);
  assert.equal(litBinding(rendered, 'run-flow-type='), 'dev');
  assert.equal(litBinding(rendered, 'run-domain='), 'perps');
});
