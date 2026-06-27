import assert from 'node:assert/strict';
import test from 'node:test';

import type { FlowType } from '@farmslot/protocol';

import {
  assertStartRefWorkBranchIsLocalOnly,
  normalizeStartRefRequest,
  StartRefPolicyError,
} from './start-ref-policy.js';

const validParams = {
  flowType: 'dev' as const,
  ticketOrPr: 'PROJ-1',
  project: 'farmslot',
  lane: 'comparison' as const,
  variant: 'candidate-a',
  completionPolicy: 'artifact-only' as const,
  startRef: 'main',
};

test('normalizeStartRefRequest accepts artifact-only dev/fix-bug comparison runs with explicit variant', () => {
  for (const flowType of ['dev', 'fix-bug'] satisfies FlowType[]) {
    assert.deepEqual(normalizeStartRefRequest({ ...validParams, flowType }), {
      requestedRef: 'main',
      source: { kind: 'manual' },
    });
  }
});

test('normalizeStartRefRequest rejects direct prior-run source provenance', () => {
  assert.throws(
    () =>
      normalizeStartRefRequest({
        ...validParams,
        startRefSource: { kind: 'prior-run', runId: 'baseline-run' },
      } as any),
    /eval\.experiment\.create \+ eval\.trial\.start/,
  );
});

test('normalizeStartRefRequest returns null when startRef is omitted', () => {
  assert.equal(normalizeStartRefRequest({ ...validParams, startRef: undefined }), null);
});

test('normalizeStartRefRequest rejects every non-implementation flow type', () => {
  for (const flowType of ['review-pr', 'pr-complete', 'merge-main'] satisfies FlowType[]) {
    assert.throws(
      () => normalizeStartRefRequest({ ...validParams, flowType }),
      StartRefPolicyError,
      `expected ${flowType} to reject startRef`,
    );
  }
});

test('normalizeStartRefRequest rejects non-comparison or publishable combinations', () => {
  assert.throws(
    () => normalizeStartRefRequest({ ...validParams, lane: 'production' }),
    /lane=comparison/,
  );
  assert.throws(
    () => normalizeStartRefRequest({ ...validParams, variant: '' }),
    /explicit variant/,
  );
  assert.throws(
    () => normalizeStartRefRequest({ ...validParams, completionPolicy: 'default' }),
    /completionPolicy=artifact-only/,
  );
});

test('normalizeStartRefRequest rejects warm reuse flags and unsafe syntax', () => {
  assert.throws(
    () => normalizeStartRefRequest({ ...validParams, skipPrepare: true }),
    /skipPrepare/,
  );
  assert.throws(() => normalizeStartRefRequest({ ...validParams, nudgeReuse: true }), /nudgeReuse/);
  assert.throws(() => normalizeStartRefRequest({ ...validParams, freshReuse: true }), /freshReuse/);
  assert.throws(
    () => normalizeStartRefRequest({ ...validParams, startRef: 'main; rm -rf /' }),
    /whitespace|Invalid startRef syntax/,
  );
});

test('assertStartRefWorkBranchIsLocalOnly rejects remote branch reuse for startRef runs', () => {
  assert.doesNotThrow(() =>
    assertStartRefWorkBranchIsLocalOnly({
      branch: 'feat/proj-1-candidate',
      remoteExists: false,
      startRef: { requestedRef: 'main' },
    }),
  );
  assert.doesNotThrow(() =>
    assertStartRefWorkBranchIsLocalOnly({
      branch: 'feat/proj-1-candidate',
      remoteExists: true,
      startRef: null,
    }),
  );
  assert.throws(
    () =>
      assertStartRefWorkBranchIsLocalOnly({
        branch: 'feat/proj-1-candidate',
        remoteExists: true,
        startRef: { requestedRef: 'd0932457' },
      }),
    /refuses to mutate or reuse existing remote branch 'feat\/proj-1-candidate'/,
  );
});
