import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import {
  decisionActionHelp,
  publicationGateWaitingTitle,
  retainedEvidenceGate,
} from './run-detail-decision-renderers.js';

test('publication gate title names review issues instead of worker finished', () => {
  assert.equal(
    publicationGateWaitingTitle({
      actions: [{ id: 'approve-publish-unresolved', label: 'Bypass', style: 'danger' }],
    }),
    'Publication gate: review blocked',
  );
  assert.equal(
    publicationGateWaitingTitle({
      actions: [{ id: 'continue-review-fix', label: 'Continue Fixing', style: 'primary' }],
    }),
    'Review found issues',
  );
  assert.equal(
    publicationGateWaitingTitle({
      actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
    }),
    'Worker finished — verify before marking ready',
  );
});

test('decisionActionHelp prefers persisted descriptions over fallback copy', () => {
  assert.equal(
    decisionActionHelp('engine_collision', { id: 'abort', description: 'Gateway copy' }),
    'Gateway copy',
  );
});

test('decisionActionHelp falls back for legacy collision decisions only', () => {
  assert.match(
    decisionActionHelp('engine_collision', { id: 'abort' }),
    /Cancels the current dispatch/,
  );
  assert.equal(decisionActionHelp('engine_collision', { id: 'unknown' }), '');
  assert.equal(decisionActionHelp(undefined, { id: 'abort' }), '');
});

test('a settled run exposes its latest saved gate without changing the retained decision', () => {
  const saved: RunDecision = {
    id: 'saved',
    type: 'engine_human_gate',
    title: 'Gate',
    description: 'Saved evidence',
    createdAt: '2026-01-01',
    resolvedAt: '2026-01-02',
    resolvedAction: 'superseded',
    actions: [],
    payload: {
      kind: 'ready',
      prNumber: 1,
      repo: 'fixture/source',
      workerReport: '',
      branch: 'fixture',
      diffStat: { files: 1, additions: 1, deletions: 0 },
    },
  };
  const earlier = { ...saved, id: 'earlier' };
  assert.equal(retainedEvidenceGate({ status: 'cancelled', decisions: [earlier, saved] }), saved);
  assert.equal(saved.resolvedAction, 'superseded');
  assert.equal(retainedEvidenceGate({ status: 'running', decisions: [saved] }), undefined);
  assert.equal(
    retainedEvidenceGate({
      status: 'cancelled',
      decisions: [saved, { ...saved, id: 'pending', resolvedAt: undefined }],
    }),
    undefined,
  );
});
