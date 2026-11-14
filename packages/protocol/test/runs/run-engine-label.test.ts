import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reasoningEffortLabel,
  type RunEffortSource,
  runEngineLabel,
  runnerModelEffortParts,
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

test('the label says default when no reasoning effort was sent', () => {
  assert.equal(
    runEngineLabel({ runner: 'grok', model: 'grok-4.7', effort: 'medium' }),
    'grok/grok-4.7 · medium',
  );
  assert.equal(
    runEngineLabel({ runner: 'grok', model: 'grok-4.7', effort: null }),
    'grok/grok-4.7 · default',
  );
  assert.equal(
    runEngineLabel({ runner: 'pi', model: 'litellm/glm-5p3-flash', effort: 'off' }),
    'pi/litellm/glm-5p3-flash · off',
  );
  assert.equal(
    runEngineLabel({ runner: 'pi', model: 'openai/gpt-5.1', effort: 'off' }),
    'pi/openai/gpt-5.1 · off',
  );
  assert.equal(reasoningEffortLabel(' OFF '), 'off');
  assert.equal(reasoningEffortLabel('off'), 'off');
  assert.equal(reasoningEffortLabel(null), 'default');
  assert.equal(reasoningEffortLabel('none'), 'none');
  assert.deepEqual(runnerModelEffortParts('pi', 'litellm/glm-5p3-flash', 'off'), [
    'pi',
    'litellm/glm-5p3-flash',
    'off',
  ]);
  assert.deepEqual(runnerModelEffortParts('pi', 'openai/gpt-5.1', 'off'), [
    'pi',
    'openai/gpt-5.1',
    'off',
  ]);
  assert.deepEqual(runnerModelEffortParts('pi', 'openai/gpt-5.1', '  '), [
    'pi',
    'openai/gpt-5.1',
    'default',
  ]);
  assert.deepEqual(runnerModelEffortParts(undefined, undefined, '  '), []);
  assert.equal(runEngineLabel({ runner: null, model: 'opus' }), 'runner/opus · default');
  assert.equal(runEngineLabel({ runner: 'codex', model: null, effort: 'high' }), 'codex · high');
  assert.equal(runEngineLabel({ runner: null, model: null, effort: 'high' }), null);
});

test('a flow type this client does not know still reads the dispatch effort', () => {
  assert.equal(runWorkerEffort({ ...base, flowType: 'future-flow', effort: 'high' }), 'high');
});

test('the profile choice matches the runner and model the label shows', () => {
  const run: RunEffortSource = {
    ...base,
    metrics: {},
    workflowExecution: { models: [{ runner: 'grok', model: 'grok-4.7', effort: 'minimal' }] },
  };
  assert.equal(runWorkerEffort(run), null);
  assert.equal(runWorkerEffort(run, { runner: 'grok', model: 'grok-4.7' }), 'minimal');
});

test('an exact worker request receipt names the wire decision; legacy rows keep their effort', () => {
  const engine = { runner: 'pi', model: 'litellm/glm' };
  const run: RunEffortSource = {
    flowType: 'dev',
    metrics: engine,
    effort: 'off',
    agentContexts: [{ role: 'dev', runner: 'pi', runnerSessionId: 'session', effort: 'off' }],
  };
  assert.equal(runWorkerEffort(run), 'off');
  const worker = run.agentContexts![0];
  for (const [reasoning, expected] of [
    [{ mode: 'omitted' }, 'default'],
    [{ mode: 'disabled' }, 'off'],
    [{ mode: 'level', level: 'high' }, 'high'],
  ] as const) {
    worker.reasoningReceipt = {
      sessionId: 'session',
      provider: 'litellm',
      model: 'glm',
      selectedModel: 'litellm/glm',
      observedAt: '2026-11-14T12:00:00Z',
      reasoning,
    };
    assert.equal(
      runEngineLabel({ ...engine, effort: runWorkerEffort(run) }),
      `pi/litellm/glm · ${expected}`,
    );
  }
  worker.runnerSessionId = 'successor';
  assert.equal(runWorkerEffort(run), 'off');
  worker.runnerSessionId = 'session';
  assert.equal(runWorkerEffort(run, { runner: 'pi', model: 'litellm/other' }), 'off');
  worker.attemptStartedAt = '2026-11-14T13:00:00Z';
  assert.equal(runWorkerEffort(run), 'off');
  worker.reasoningReceipt!.attemptStartedAt = worker.attemptStartedAt;
  assert.equal(runWorkerEffort(run), 'high');
});
