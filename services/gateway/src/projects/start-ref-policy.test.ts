import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { FlowType } from '@farmslot/protocol';

import {
  assertStartRefSkipPrepareEligible,
  assertStartRefWorkBranchIsLocalOnly,
  normalizeStartRefRequest,
  StartRefPolicyError,
} from './start-ref-policy.js';

const validParams = {
  flowType: 'dev' as const,
  ticketOrPr: 'PROJ-1',
  project: 'farmslot-farm',
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
  for (const flowType of ['qa', 'review-pr', 'pr-complete', 'update-branch'] satisfies FlowType[]) {
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

test('normalizeStartRefRequest rejects skipPrepare unless slot HEAD was verified', () => {
  assert.throws(
    () => normalizeStartRefRequest({ ...validParams, skipPrepare: true }),
    /skipPrepare/,
  );
  assert.deepEqual(
    normalizeStartRefRequest({
      ...validParams,
      skipPrepare: true,
      startRefSkipPrepareVerified: true,
    }),
    { requestedRef: 'main', source: { kind: 'manual' } },
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

test('a pinned comparison run cannot skip prepare, whatever its slot HEAD', async () => {
  // A project config that cannot be read counts as one that pins prepare.
  await assert.rejects(
    assertStartRefSkipPrepareEligible({
      startRef: '260bd3a5',
      skipPrepare: true,
      slotId: 'macwork-mm-2',
      project: 'pinned-prepare-absent-project',
      flowType: 'dev',
    }),
    /A pinned comparison run cannot skip prepare/,
  );
  // A project that does not pin keeps the HEAD check, which needs the slot.
  await assert.rejects(
    assertStartRefSkipPrepareEligible({
      startRef: '260bd3a5',
      skipPrepare: true,
      project: 'farmslot-farm',
      flowType: 'dev',
    }),
    /startRef with skipPrepare requires slotId/,
  );
});

test('a project that pins prepare refuses skipPrepare on a start-ref run', async (t) => {
  const projects = mkdtempSync(path.join(tmpdir(), 'start-ref-pinned-'));
  const previous = process.env.FARMSLOT_PROJECTS_DIR;
  process.env.FARMSLOT_PROJECTS_DIR = projects;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_PROJECTS_DIR;
    else process.env.FARMSLOT_PROJECTS_DIR = previous;
    rmSync(projects, { recursive: true, force: true });
  });
  mkdirSync(path.join(projects, 'pinning-pack'));
  writeFileSync(
    path.join(projects, 'pinning-pack', 'project.json'),
    JSON.stringify({ name: 'pinning-pack', hooks: { artifact_check: 'probe' } }),
  );
  await assert.rejects(
    assertStartRefSkipPrepareEligible({
      startRef: '260bd3a5',
      skipPrepare: true,
      slotId: 'macwork-mm-2',
      project: 'pinning-pack',
      flowType: 'dev',
    }),
    /A pinned comparison run cannot skip prepare/,
  );
});
