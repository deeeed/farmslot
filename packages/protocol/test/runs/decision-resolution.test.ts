import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload } from '../../src/contracts/runs.js';
import {
  buildRunResolveDecisionParams,
  readyResolveSelectionData,
} from '../../src/runs/decision-resolution.js';

const payload = {
  kind: 'ready',
  publicationTarget: 'pull_request',
  prPackage: {
    id: 'pkg-1',
    packageHash: 'hash-1',
    headSha: 'abc123',
    publicationTarget: 'pull_request',
    selectedEvidenceKeys: ['evidence/result.json'],
  },
} as ReadyGatePayload;

test('ready gate selection binds the exact package identity', () => {
  assert.deepEqual(readyResolveSelectionData({ payload }), {
    publicationTarget: 'pull_request',
    selectedEvidenceKeys: ['evidence/result.json'],
    packageId: 'pkg-1',
    packageHash: 'hash-1',
    packageHeadSha: 'abc123',
  });
});

test('ready gate selection lets an interactive surface override draft choices', () => {
  assert.deepEqual(
    readyResolveSelectionData({
      payload,
      publicationTarget: 'none',
      selectedEvidenceKeys: [],
      extraSelectionData: { operatorNote: 'hold evidence' },
    }),
    {
      publicationTarget: 'none',
      selectedEvidenceKeys: [],
      packageId: 'pkg-1',
      packageHash: 'hash-1',
      packageHeadSha: 'abc123',
      operatorNote: 'hold evidence',
    },
  );
});

test('run decision params preserve action selection and bind ready package identity', () => {
  assert.deepEqual(
    buildRunResolveDecisionParams({
      runId: 'run-1',
      decision: { id: 'decision-1', payload },
      actionId: 'approve-publish',
      publicationTarget: 'draft',
      selectedEvidenceKeys: [],
      selectionData: { operatorNote: 'reviewed' },
    }),
    {
      runId: 'run-1',
      decisionId: 'decision-1',
      actionId: 'approve-publish',
      selectionData: {
        publicationTarget: 'draft',
        selectedEvidenceKeys: [],
        packageId: 'pkg-1',
        packageHash: 'hash-1',
        packageHeadSha: 'abc123',
        operatorNote: 'reviewed',
      },
    },
  );
});

test('run decision params stay minimal for actions without selection data', () => {
  assert.deepEqual(
    buildRunResolveDecisionParams({
      runId: 'run-1',
      decision: { id: 'decision-1' },
      actionId: 'continue',
    }),
    {
      runId: 'run-1',
      decisionId: 'decision-1',
      actionId: 'continue',
    },
  );
});
