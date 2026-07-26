import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { DispatchQueueAddParams, RunCreateParams } from '@farmslot/protocol';

import {
  buildDispatchQueueAddParams,
  buildRunCreateParams,
  type DispatchPayloadDraft,
} from './dispatch-wizard-payload.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/dispatch-payload/${name}.json`, import.meta.url), 'utf8'),
  );
}

function stablePayload<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

const baseDraft = {
  allowedSlots: undefined,
  branch: undefined,
  effort: undefined,
  app: undefined,
  taskTemplate: undefined,
  skipPrepare: undefined,
  nudgeReuse: undefined,
  freshReuse: undefined,
  reviewTier: undefined,
  reviewDepth: undefined,
  pendingReviewPlan: undefined,
  comparison: {},
} satisfies Partial<DispatchPayloadDraft>;

test('buildRunCreateParams matches golden fix-bug payload', () => {
  const payload = buildRunCreateParams({
    ...baseDraft,
    flowType: 'fix-bug',
    project: 'example-mobile',
    ticketOrPr: 'PROJ-2368',
    slotId: 'runner-a-example-mobile-1',
    allowedSlots: ['runner-a-example-mobile-1', 'runner-a-example-mobile-2'],
    model: 'sonnet',
    runner: 'claude',
    mode: 'autonomous',
    devInteractiveProfile: 'lightweight',
    reviewDepth: {
      minimumIndependentReviews: 1,
      extraLoopsRequested: 1,
      requireCrossRunner: true,
      requestedBy: 'dispatch',
    },
    pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'static-code' }],
    comparison: {},
  });
  assert.deepEqual(stablePayload<RunCreateParams>(payload), fixture('fix-bug-run'));
});

test('buildRunCreateParams matches golden review-pr payload', () => {
  const payload = buildRunCreateParams({
    ...baseDraft,
    flowType: 'review-pr',
    project: 'example-mobile',
    ticketOrPr: 'example-org/example-mobile#123',
    branch: 'fix/proj-123',
    model: 'gpt-5.4',
    runner: 'codex',
    app: 'apps/mobile',
    mode: 'interactive',
    devInteractiveProfile: 'lightweight',
    reviewTier: 'standard',
    comparison: {},
  });
  assert.deepEqual(stablePayload<RunCreateParams>(payload), fixture('review-pr-run'));
});

test('buildRunCreateParams matches golden comparison rerun payload', () => {
  const payload = buildRunCreateParams({
    ...baseDraft,
    flowType: 'fix-bug',
    project: 'example-mobile',
    ticketOrPr: 'PROJ-2368',
    model: 'sonnet',
    runner: 'claude',
    mode: 'autonomous',
    devInteractiveProfile: 'lightweight',
    comparison: {
      lane: 'comparison',
      familyId: 'family-1',
      variant: 'claude-sonnet-v2',
      parentRunId: 'run-parent',
    },
  });
  assert.deepEqual(stablePayload<RunCreateParams>(payload), fixture('comparison-rerun-run'));
});

test('buildRunCreateParams matches golden dev-interactive payload', () => {
  const payload = buildRunCreateParams({
    ...baseDraft,
    flowType: 'dev',
    project: 'extension',
    ticketOrPr: 'Investigate flaky onboarding spec',
    model: 'gpt-5.5',
    runner: 'codex',
    effort: 'high',
    mode: 'interactive',
    devInteractiveProfile: 'reviewed',
    taskTemplate: { fileName: 'dev-interactive.md', variant: 'deep-dive' },
    comparison: {},
  });
  assert.deepEqual(stablePayload<RunCreateParams>(payload), fixture('dev-interactive-run'));
});

test('buildDispatchQueueAddParams matches golden queue-add payload', () => {
  const payload = buildDispatchQueueAddParams({
    ...baseDraft,
    flowType: 'review-pr',
    project: 'example-browser',
    ticketOrPr: 'example-org/example-browser#456',
    slotId: 'runner-a-example-browser-2',
    allowedSlots: ['runner-a-example-browser-2'],
    branch: 'feature/pr-456',
    model: 'sonnet',
    runner: 'claude',
    mode: 'interactive',
    devInteractiveProfile: 'lightweight',
    comparison: {
      lane: 'comparison',
      familyId: 'family-456',
      variant: 'claude-sonnet',
      parentRunId: 'run-456',
    },
  });
  assert.deepEqual(stablePayload<DispatchQueueAddParams>(payload), fixture('queue-add'));
});

test('configured execution-template selection is identical for direct and queued dispatch', () => {
  const draft: DispatchPayloadDraft = {
    ...baseDraft,
    flowType: 'fix-bug',
    project: 'example-mobile',
    ticketOrPr: 'PROJ-2368',
    slotId: 'runner-a-example-mobile-1',
    mode: 'autonomous',
    devInteractiveProfile: 'lightweight',
    domain: 'trading',
    executionTemplateId: 'fix-bug/trading-mobile',
    comparison: {},
  };
  const direct = buildRunCreateParams(draft);
  const queued = buildDispatchQueueAddParams(draft);
  assert.equal(direct.domain, 'trading');
  assert.equal(queued.domain, 'trading');
  assert.equal(direct.executionTemplateId, 'fix-bug/trading-mobile');
  assert.equal(queued.executionTemplateId, 'fix-bug/trading-mobile');
  assert.equal(direct.taskTemplate, undefined);
  assert.equal(queued.taskTemplate, undefined);
});

test('buildRunCreateParams forwards prepareProfile and suppresses it under skipPrepare', () => {
  const draft: DispatchPayloadDraft = {
    ...baseDraft,
    flowType: 'fix-bug',
    project: 'demo',
    ticketOrPr: 'DEMO-1',
    mode: 'autonomous',
    devInteractiveProfile: 'lightweight',
    prepareProfile: 'relaunch',
    comparison: {},
  };
  assert.equal(buildRunCreateParams(draft).prepareProfile, 'relaunch');
  assert.equal(buildDispatchQueueAddParams(draft).prepareProfile, 'relaunch');
  const skipped: DispatchPayloadDraft = { ...draft, skipPrepare: true };
  assert.equal(buildRunCreateParams(skipped).prepareProfile, undefined);
  assert.equal(buildRunCreateParams(skipped).skipPrepare, true);
  assert.equal(buildDispatchQueueAddParams(skipped).prepareProfile, undefined);
});
