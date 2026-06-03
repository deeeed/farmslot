import assert from 'node:assert/strict';
import test from 'node:test';

import type { DispatchCandidatesResult, PRStatus, SlotStatus } from '@farmslot/protocol';

import {
  candidateDispatchable,
  dispatchableCandidates,
  findSameTaskSlot,
  resolveAllowedSlots,
  resolveTargetBranch,
  selectedCandidate,
  selectedNudgeIntent,
  slotSummaryLabel,
} from './dispatch-wizard-selectors.js';

const prs: PRStatus[] = [
  { pr: 123, repo: 'example-org/mobile', project: 'mobile', headRef: 'fix/123' } as PRStatus,
  { pr: 456, repo: 'example-org/ext', project: 'ext', headRef: 'fix/456' } as PRStatus,
];

const candidates: DispatchCandidatesResult['candidates'] = [
  {
    slotId: 'a',
    score: 10,
    cdpLive: true,
    branch: 'main',
    lifecycle: 'idle',
    onMain: true,
    free: false,
  },
  {
    slotId: 'b',
    score: 5,
    cdpLive: true,
    branch: 'fix/123',
    lifecycle: 'busy',
    onMain: false,
    free: false,
    nudgeEligible: true,
    nudgeMeta: {
      uncommittedCount: 0,
      uncommittedFiles: [],
      nudgeCount: 0,
      ctxPct: null,
      prMatchKind: 'pr-number',
      riskFlags: [],
      canNudge: false,
    },
  },
  {
    slotId: 'c',
    score: 1,
    cdpLive: true,
    branch: 'main',
    lifecycle: 'idle',
    onMain: true,
    free: true,
  },
];

test('resolveTargetBranch handles canonical PR refs and unique bare numbers', () => {
  assert.equal(
    resolveTargetBranch({
      prs,
      flowType: 'review-pr',
      ticketId: '',
      normalizedTicket: 'example-org/mobile#123',
      project: 'mobile',
    }),
    'fix/123',
  );
  assert.equal(
    resolveTargetBranch({
      prs,
      flowType: null,
      ticketId: '456',
      normalizedTicket: '',
      project: 'ext',
    }),
    'fix/456',
  );
  assert.equal(
    resolveTargetBranch({
      prs,
      flowType: 'fix-bug',
      ticketId: '456',
      normalizedTicket: '',
      project: 'ext',
    }),
    undefined,
  );
});

test('candidate selectors include nudge-eligible rows as dispatchable', () => {
  assert.equal(candidateDispatchable(candidates[0]!), false);
  assert.equal(candidateDispatchable(candidates[1]!), true);
  assert.deepEqual(
    dispatchableCandidates(candidates).map((candidate) => candidate.slotId),
    ['b', 'c'],
  );
  assert.equal(selectedCandidate(candidates, 'b')?.slotId, 'b');
  assert.equal(selectedNudgeIntent({ candidates, slotOverride: 'b', intents: new Map() }), 'fresh');
  assert.equal(
    selectedNudgeIntent({ candidates, slotOverride: 'b', intents: new Map([['b', 'nudge']]) }),
    'nudge',
  );
});

test('resolveAllowedSlots resolves active machine filter against fleet-wide slots', () => {
  const slots = [
    { slot: 'runner-a-mobile-1', machine: 'runner-a', project: 'mobile' },
    { slot: 'vegeta-mobile-1', machine: 'vegeta', project: 'mobile' },
    { slot: 'runner-a-browser-1', machine: 'runner-a', project: 'ext' },
  ] as SlotStatus[];
  assert.equal(
    resolveAllowedSlots({ machines: [], fleetSlots: slots, project: 'mobile' }),
    undefined,
  );
  assert.deepEqual(
    resolveAllowedSlots({ machines: ['runner-a'], fleetSlots: slots, project: 'mobile' }),
    ['runner-a-mobile-1'],
  );
});

test('slot helpers find same task and summarize active run', () => {
  const slots = [
    {
      slot: 'runner-a-mobile-1',
      machine: 'runner-a',
      project: 'mobile',
      taskId: 'proj-1',
      currentRunId: 'run-1',
      taskFile: 'TASK.md',
    },
  ] as SlotStatus[];
  assert.equal(findSameTaskSlot(slots, 'PROJ-1')?.slot, 'runner-a-mobile-1');
  assert.equal(
    slotSummaryLabel({
      slotId: 'runner-a-mobile-1',
      slots,
      runs: [{ id: 'run-1', summary: 'Fix bug' }] as never,
    }),
    'Fix bug',
  );
});
