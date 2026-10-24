import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceDependenciesForRead, resourceQuery } from '../../src/client-cache/index.js';

const methods = [
  'prWatch.list',
  'prWatch.get',
  'prRules.list',
  'prReview.get',
  'prPush.list',
  'assessment.list',
  'assessment.get',
  'assessment.summary',
  'assessment.status',
  'assessment.report',
  'decision.advice.get',
  'intelligence.triage.get',
  'analytics.query',
  'copilot.status',
  'chat.sessionContext',
  'chat.context',
  'chat.observerEvidence',
] as const;

test('D07 remaining domains use memory-only observed reads with canonical selector identity', () => {
  for (const method of methods) {
    const params =
      method === 'decision.advice.get'
        ? { runId: 'run-1', decisionId: 'decision-1' }
        : method === 'intelligence.triage.get'
          ? { runId: 'run-1' }
          : ['prWatch.get', 'prReview.get', 'assessment.get', 'assessment.report'].includes(method)
            ? { id: 'record-1' }
            : {};
    const query = resourceQuery(method, params);
    assert.equal(query.persisted, false, method);
    assert.equal(query.requiresObservedRead, true, method);
    assert.deepEqual(resourceDependenciesForRead(method, query.params), query.dependencies, method);
  }
  assert.equal(
    resourceQuery('chat.sessionContext').id,
    resourceQuery('chat.sessionContext', { sessionId: 'default' }).id,
  );
  assert.equal(
    resourceQuery('chat.sessionContext', { sessionId: ' global ' }).id,
    resourceQuery('chat.sessionContext').id,
  );
  assert.equal(
    resourceQuery('analytics.query', { until: '2026-10-24T00:00:00Z' }).id,
    resourceQuery('analytics.query', { until: '2026-10-24T00:00:00.000Z', project: undefined }).id,
  );
});

test('private detail selectors never become notification keys, filtered analytics includes full corpus dependency', () => {
  assert.deepEqual(resourceQuery('assessment.get', { id: 'private-assessment' }).dependencies, [
    { family: 'assessment', scope: 'farm' },
  ]);
  assert.deepEqual(resourceQuery('analytics.query', { project: 'project-a' }).dependencies, [
    { family: 'analytics', scope: 'farm' },
  ]);
  assert.deepEqual(resourceQuery('prWatch.get', { id: 'private-monitor' }).dependencies, [
    { family: 'pr-automation', scope: 'farm' },
    { family: 'runs', scope: 'farm' },
    { family: 'planning', collection: 'dispatch-queue' },
    { family: 'configuration', scope: 'farm' },
  ]);
});

test('commands, owner injection, raw packets and unsafe selectors never enter observation IDs', () => {
  for (const method of [
    'prWatch.refresh',
    'prWatch.repair',
    'prReview.request',
    'prRules.scan',
    'analytics.backfill',
    'assessment.evaluate',
    'assessment.test',
    'assessment.feedback',
    'copilot.configure',
    'copilot.start',
    'copilot.stop',
    'decision.advice.analyze',
    'intelligence.triage.analyze',
  ])
    assert.equal(resourceDependenciesForRead(method, {}), undefined, method);
  assert.throws(() => resourceQuery('assessment.report'), /id/);
  assert.throws(
    () => resourceQuery('assessment.report', { assessmentId: 'new-artifact' }),
    /commands/,
  );
  assert.throws(() => resourceQuery('prWatch.list', { ownerId: 'another-owner' }), /owner/);
  assert.throws(() => resourceQuery('prWatch.get', { id: '../private' }), /selector/);
  assert.throws(() => resourceQuery('analytics.query', { token: 'never-in-a-key' }), /commands/);
  assert.throws(() => resourceQuery('assessment.list', { limit: 101 }), /page/);
  assert.throws(
    () => resourceQuery('chat.sessionContext', { sessionId: '../private' }),
    /selector/,
  );
  assert.throws(
    () =>
      resourceDependenciesForRead('decision.advice.get', { runId: '../private', decisionId: 'a' }),
    /selector/,
  );
});

test('observer windows canonicalize supported clamps without accepting owner or raw-source fields', () => {
  assert.equal(
    resourceQuery('chat.observerEvidence').id,
    resourceQuery('chat.observerEvidence', { windowMs: 7200000, limit: 20 }).id,
  );
  assert.deepEqual(resourceQuery('chat.observerEvidence', { windowMs: -1, limit: 99 }).params, {
    windowMs: 1000,
    limit: 50,
  });
  assert.throws(
    () => resourceQuery('chat.observerEvidence', { type: '/private/source' }),
    /selector/,
  );
  assert.throws(() => resourceQuery('chat.observerEvidence', { ownerId: 'foreign' }), /owner/);
});
