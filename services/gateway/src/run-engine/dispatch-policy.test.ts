import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CURSOR_MODEL } from '@farmslot/protocol';

import {
  buildDispatchPreviewParamsForRun,
  resolveCIWatchChainFlowType,
  resolveCIWatchTerminalPatch,
  resolveRunDispatchRunnerModel,
} from './dispatch-policy.js';
import { makeRun } from './test-fixtures.js';

test('buildDispatchPreviewParamsForRun sets targetBranch only for PR-bound flows', () => {
  const reviewRun = makeRun({ flowType: 'review-pr', branch: 'feat/proj-42' });
  assert.equal(buildDispatchPreviewParamsForRun(reviewRun).targetBranch, 'feat/proj-42');

  const prCompleteRun = makeRun({ flowType: 'pr-complete', branch: 'fix/proj-99' });
  assert.equal(buildDispatchPreviewParamsForRun(prCompleteRun).targetBranch, 'fix/proj-99');

  // Non-PR flows shouldn't get the bonus — they WANT a clean main slot.
  const bugRun = makeRun({ flowType: 'fix-bug', branch: 'fix/proj-1-codex' });
  assert.equal(buildDispatchPreviewParamsForRun(bugRun).targetBranch, undefined);

  // Missing branch (PR flow that hasn't resolved it yet) stays undefined
  // rather than accidentally bonusing the first empty-branch slot. Using ''
  // since makeRun's `?? fallback` swallows an explicit `null` override.
  const reviewNoBranch = makeRun({ flowType: 'review-pr', branch: '' });
  assert.equal(buildDispatchPreviewParamsForRun(reviewNoBranch).targetBranch, undefined);
});

test('buildDispatchPreviewParamsForRun forwards explicit profile and app', () => {
  const run = makeRun({
    flowType: 'pr-complete',
    app: 'companion',
    prepareProfile: 'sandbox',
  });

  const params = buildDispatchPreviewParamsForRun(run);

  assert.equal(params.app, 'companion');
  assert.equal(params.prepareProfile, 'sandbox');
});

test('buildDispatchPreviewParamsForRun preserves execution-template selection context', () => {
  const params = buildDispatchPreviewParamsForRun(
    makeRun({
      mode: 'autonomous',
      domain: 'trading',
      executionTemplateId: 'fix-bug/autonomous.extension',
    }),
  );

  assert.equal(params.mode, 'autonomous');
  assert.equal(params.domain, 'trading');
  assert.equal(params.executionTemplateId, 'fix-bug/autonomous.extension');
});

test('resolveCIWatchTerminalPatch maps blocked to blocked/partial', () => {
  const patch = resolveCIWatchTerminalPatch({ result: 'blocked' });
  assert.deepEqual(patch, {
    status: 'blocked',
    metrics: {
      outcome: 'partial',
    },
  });
});

test('resolveCIWatchTerminalPatch maps comments to success and failed to failure', () => {
  assert.deepEqual(resolveCIWatchTerminalPatch({ result: 'comments' }), {
    metrics: {
      outcome: 'success',
    },
  });
  assert.deepEqual(resolveCIWatchTerminalPatch({ result: 'failed' }), {
    metrics: {
      outcome: 'failure',
    },
  });
});

test('resolveRunDispatchRunnerModel defaults explicit Cursor runner to the shared default', () => {
  const run = makeRun({
    metrics: {
      nudgeCount: 0,
      runner: 'cursor',
      model: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
  });
  assert.deepEqual(resolveRunDispatchRunnerModel(run, { runner: 'claude', model: 'opus' }), {
    runner: 'cursor',
    model: DEFAULT_CURSOR_MODEL,
  });
});

test('resolveRunDispatchRunnerModel treats unknown Cursor model as unset', () => {
  const run = makeRun({
    metrics: {
      nudgeCount: 0,
      runner: 'cursor',
      model: 'unknown',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
  });
  assert.deepEqual(resolveRunDispatchRunnerModel(run, { runner: 'claude', model: 'opus' }), {
    runner: 'cursor',
    model: DEFAULT_CURSOR_MODEL,
  });
});

test('resolveCIWatchChainFlowType maps dispatch actions to follow-up flows', () => {
  assert.equal(resolveCIWatchChainFlowType('dispatch-update-branch'), 'update-branch');
  assert.equal(resolveCIWatchChainFlowType('dispatch-pr-complete'), 'pr-complete');
  assert.equal(resolveCIWatchChainFlowType('skip'), null);
  assert.equal(resolveCIWatchChainFlowType(undefined), null);
});
