import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import {
  type RunEffortSource,
  runEngineLabel,
  runWorkerEffort,
} from '../../src/runs/run-engine-label.js';

const base: RunEffortSource = {
  flowType: 'dev',
  metrics: { runner: 'grok', model: 'grok-4.7' },
};

test('the worker context the dispatch launched names the effort first', () => {
  const run: RunEffortSource = {
    ...base,
    effort: 'low',
    agentContexts: [
      { role: 'review', effort: 'xhigh' },
      { role: 'dev', effort: 'medium', nativeSession: { effort: 'high' } },
    ],
    workflowExecution: { models: [{ runner: 'grok', model: 'grok-4.7', effort: 'minimal' }] },
  };
  assert.equal(runWorkerEffort(run), 'medium');
});

test('then its native session, the dispatch effort, and the matching profile choice', () => {
  const contexts: RunEffortSource['agentContexts'] = [
    { role: 'dev', nativeSession: { effort: 'high' } },
  ];
  assert.equal(runWorkerEffort({ ...base, effort: 'low', agentContexts: contexts }), 'high');
  assert.equal(runWorkerEffort({ ...base, effort: ' low ', agentContexts: [] }), 'low');
  const workflowExecution: RunEffortSource['workflowExecution'] = {
    models: [
      { runner: 'claude', model: 'opus', effort: 'max' },
      { runner: 'grok', model: 'grok-4.7', effort: 'minimal' },
    ],
  };
  assert.equal(runWorkerEffort({ ...base, workflowExecution }), 'minimal');
});

test('a reviewer context or another profile choice never stands in for the worker', () => {
  assert.equal(
    runWorkerEffort({
      ...base,
      agentContexts: [{ role: 'review', effort: 'xhigh' }],
      workflowExecution: { models: [{ runner: 'claude', model: 'opus', effort: 'max' }] },
    }),
    null,
  );
  assert.equal(runWorkerEffort({ ...base, effort: '  ' }), null);
  // review-pr runs work in the review role.
  assert.equal(
    runWorkerEffort({
      ...base,
      flowType: 'review-pr',
      agentContexts: [{ role: 'review', effort: 'xhigh' }],
    }),
    'xhigh',
  );
});

test('the label adds the effort only when known', () => {
  assert.equal(
    runEngineLabel({ runner: 'grok', model: 'grok-4.7', effort: 'medium' }),
    'grok/grok-4.7 · medium',
  );
  assert.equal(
    runEngineLabel({ runner: 'grok', model: 'grok-4.7', effort: null }),
    'grok/grok-4.7',
  );
  assert.equal(runEngineLabel({ runner: null, model: 'opus' }), 'runner/opus');
  assert.equal(runEngineLabel({ runner: 'codex', model: null, effort: 'high' }), 'codex · high');
  assert.equal(runEngineLabel({ runner: null, model: null, effort: 'high' }), null);
});

test('a full run record satisfies the effort source', () => {
  const source = (run: Run): RunEffortSource => run;
  assert.equal(typeof source, 'function');
});
