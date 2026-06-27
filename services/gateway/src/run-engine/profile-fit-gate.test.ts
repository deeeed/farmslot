import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunTicketData } from '@farmslot/protocol';

import { detectProfileFit, resolveCompanionSlotId } from './profile-fit-gate.js';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-12345678',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'created',
    project: 'farmslot',
    ticketOrPr: 'FS-101',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  } as Run;
}

const companionTicket: RunTicketData = {
  source: 'jira',
  title: 'Companion pairing banner stale after gateway reconnect',
  description: 'apps/companion should refresh when gateway URL changes.',
  acceptanceCriteria: ['Companion shows connected state on device.'],
  affectedArea: 'mobile companion',
  stepsToReproduce: [],
  screenshots: [],
  labels: ['companion'],
};

test('profile fit gate ignores non-farmslot projects', () => {
  assert.equal(
    detectProfileFit(run({ project: 'metamask-mobile-farm' }), companionTicket, {
      slotPlatform: 'cli',
    }),
    null,
  );
});

test('profile fit gate ignores explicit operator prepare profile', () => {
  assert.equal(
    detectProfileFit(run({ prepareProfile: 'sandbox' }), companionTicket, {
      prepareProfile: 'sandbox',
      slotPlatform: 'cli',
    }),
    null,
  );
});

test('profile fit gate suggests stack-dogfood for companion + gateway ticket on cli slot', () => {
  const result = detectProfileFit(
    run(),
    {
      ...companionTicket,
      description: 'Update gateway RPC and companion pairing UI.',
    },
    { slotPlatform: 'cli' },
  );

  assert.equal(result?.suggestedPrepareProfile, 'stack-dogfood');
  assert.equal(result?.confidence, 'high');
  assert.ok((result?.validationPlan?.length ?? 0) >= 2);
});

test('profile fit gate emits validation plan steps for multi-surface tickets', () => {
  const result = detectProfileFit(
    run(),
    {
      ...companionTicket,
      description: 'Update gateway RPC and companion pairing UI.',
    },
    { slotPlatform: 'cli' },
  );
  assert.equal(result?.suggestedPrepareProfile, 'stack-dogfood');
  assert.ok((result?.validationPlan?.length ?? 0) >= 3);
});

test('profile fit gate warns when gateway-only sandbox is default for companion ticket', () => {
  const result = detectProfileFit(run(), companionTicket, { slotPlatform: 'cli' });
  assert.equal(result?.suggestedPrepareProfile, 'stack-dogfood');
});

test('resolveCompanionSlotId finds dedicated mobile slot for project', () => {
  const slot = resolveCompanionSlotId(
    [
      { slot: 'macwork-ff-2', project: 'farmslot', platform: 'cli' },
      { slot: 'macwork-fc-1', project: 'farmslot', platform: 'ios' },
    ],
    'farmslot',
  );
  assert.equal(slot, 'macwork-fc-1');
});

test('profile fit validation plan includes companion slot when fleet exposes one', () => {
  const result = detectProfileFit(
    run(),
    {
      ...companionTicket,
      description: 'Update gateway RPC and companion pairing UI.',
    },
    { slotPlatform: 'cli', companionSlotId: 'macwork-fc-1' },
  );
  const companionStep = result?.validationPlan?.find((step) => step.surface === 'companion');
  assert.equal(companionStep?.slot, 'macwork-fc-1');
});