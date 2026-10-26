import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunRecipeRunsForRunResult, TaskProgressResult } from '@farmslot/protocol';
import {
  type GatewayResourceCache,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { DECISION_EVIDENCE_RECIPE_RUN_PARAM } from '../../lib/artifact-url';

import { assertRunEvidenceReady, runEvidenceQuery } from './run-evidence';

function run(digest = 'manifest-a'): Run {
  return {
    id: 'run-a',
    decisions: [{ id: 'review-a', payload: { kind: 'output-review', manifestDigest: digest } }],
  } as Run;
}

test('report evidence reads the pending decision snapshot and preserves explicit execution selection', () => {
  const query = runEvidenceQuery('run-a', run(), DECISION_EVIDENCE_RECIPE_RUN_PARAM)!;
  assert.deepEqual(query.params, {
    runId: 'run-a',
    includeRecordedEvidence: true,
    decisionId: 'review-a',
    evidenceSnapshotHash: 'manifest-a',
  });
  const selected = runEvidenceQuery('run-a', run(), 'execution-a')!;
  assert.deepEqual(selected.params, { ...(query.params as object), recipeRunId: 'execution-a' });
  assert.notEqual(query.id, runEvidenceQuery('run-a', run('manifest-b'), null)!.id);
  const next = run();
  next.decisions[0]!.id = 'review-b';
  assert.notEqual(query.id, runEvidenceQuery('run-a', next, null)!.id);
  assert.equal(runEvidenceQuery('run-b', run(), null), undefined);
  assert.equal(runEvidenceQuery('run-a', null, null), undefined);
  next.decisions = [];
  assert.deepEqual(runEvidenceQuery('run-a', next, 'execution-a')!.params, {
    runId: 'run-a',
    includeRecordedEvidence: true,
    recipeRunId: 'execution-a',
  });
});

test('a retained invocation rereads progress and evidence and refuses replaced context without sending', () => {
  const recipeQuery = runEvidenceQuery('run-a', run(), null)!;
  const progressQuery = resourceQuery<TaskProgressResult>('task.progress', { slotId: 'slot-a' });
  const evidence = { recipeRuns: [] } as unknown as RunRecipeRunsForRunResult;
  const states = new Map<string, ResourceQueryState<unknown>>([
    [recipeQuery.id, { status: 'ready', data: evidence }],
    [progressQuery.id, { status: 'ready' }],
  ]);
  const cache: GatewayResourceCache = {
    read<T>(query: { id: string }) {
      return states.get(query.id)! as ResourceQueryState<T>;
    },
    observe() {
      throw new Error('not observed in this invocation test');
    },
    retry() {
      throw new Error('not retried in this invocation test');
    },
    hasContent() {
      throw new Error('content is not checked in this invocation test');
    },
    readContent() {
      throw new Error('content is not read in this invocation test');
    },
    openContent() {
      throw new Error('content is not opened in this invocation test');
    },
    readContentByAlias() {
      throw new Error('content is not read in this invocation test');
    },
    openContentByAlias() {
      throw new Error('content is not opened in this invocation test');
    },
    storeContent() {
      throw new Error('content is not stored in this invocation test');
    },
    contentWriteToken() {
      throw new Error('content is not fetched in this invocation test');
    },
    async dispose() {
      states.clear();
    },
  };
  let sends = 0;
  const input = {
    cache,
    currentCache: cache,
    contextCurrent: true,
    recipeQuery,
    progressQuery,
    evidence,
  };
  const invoke = () => {
    assertRunEvidenceReady(input);
    sends += 1;
  };
  states.set(progressQuery.id, { status: 'stale' });
  assert.throws(invoke, /acceptance/);
  states.set(progressQuery.id, { status: 'ready' });
  states.set(recipeQuery.id, { status: 'stale', data: evidence });
  assert.throws(invoke, /evidence/);
  states.set(recipeQuery.id, { status: 'ready', data: { recipeRuns: [] } });
  assert.throws(invoke, /evidence/);
  states.set(recipeQuery.id, { status: 'ready', data: evidence });
  input.contextCurrent = false;
  assert.throws(invoke, /context changed/);
  input.contextCurrent = true;
  input.currentCache = { ...cache };
  assert.throws(invoke, /context changed/);
  assert.equal(sends, 0);
  input.currentCache = cache;
  invoke();
  assert.equal(sends, 1);
});
