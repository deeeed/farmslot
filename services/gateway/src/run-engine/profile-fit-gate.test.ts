import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunTicketData } from '@farmslot/protocol';

import { detectProfileFit } from './profile-fit-gate.js';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-12345678',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'created',
    project: 'farmslot-farm',
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

test('profile fit gate suggests sandbox-companion for companion + gateway ticket on cli slot', () => {
  const result = detectProfileFit(
    run(),
    {
      ...companionTicket,
      description: 'Update gateway RPC and companion pairing UI.',
    },
    { slotPlatform: 'cli' },
  );

  assert.equal(result?.suggestedPrepareProfile, 'sandbox-companion');
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
  assert.equal(result?.suggestedPrepareProfile, 'sandbox-companion');
  assert.ok((result?.validationPlan?.length ?? 0) >= 3);
});

test('profile fit gate warns when gateway-only sandbox is default for companion ticket', () => {
  const result = detectProfileFit(run(), companionTicket, { slotPlatform: 'cli' });
  assert.equal(result?.suggestedPrepareProfile, 'sandbox-companion');
});

test('profile fit validation plan keeps companion proof on dispatch slot', () => {
  const result = detectProfileFit(
    run(),
    {
      ...companionTicket,
      description: 'Update gateway RPC and companion pairing UI.',
    },
    { slotPlatform: 'cli' },
  );
  const companionStep = result?.validationPlan?.find((step) => step.surface === 'companion');
  assert.equal(companionStep?.prepareProfile, 'sandbox-companion');
  assert.equal(companionStep?.slot, undefined);
});

test('profile fit may false-positive on expo substring inside exposes (advisory only)', () => {
  // Token match is substring-based; "exposes" contains "expo". Callers must not
  // stamp suggestedPrepareProfile onto queue items — selection is explicit-only.
  const result = detectProfileFit(
    run(),
    {
      source: 'manual',
      title: 'Command Center inventory tables',
      description: 'The runs page exposes inventory tables in Command Center.',
      acceptanceCriteria: ['Table exposes columns'],
      affectedArea: 'command-center',
      stepsToReproduce: [],
      screenshots: [],
      labels: ['command-center'],
    },
    { slotPlatform: 'cli' },
  );
  // Advisory surface may still suggest companion; effective selection ignores this.
  assert.equal(result?.suggestedPrepareProfile, 'sandbox-companion');
});