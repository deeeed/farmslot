import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '../../src/client-cache/index.js';

test('candidate observations keep context and normalize machine selection', () => {
  const a = resourceQuery('dispatch.candidates', {
    machines: ['mini', 'macpro', 'mini'],
    runner: 'pi',
    model: 'litellm/glm-5p3',
  });
  const b = resourceQuery('dispatch.candidates', {
    machines: ['macpro', 'mini'],
    runner: 'pi',
    model: 'litellm/glm-5p3',
  });
  assert.equal(a.id, b.id);
  assert.equal(a.persisted, true);
  assert.ok(a.dependencies.some((key) => key.family === 'slots'));
  assert.ok(a.dependencies.some((key) => key.family === 'runs'));
  assert.notEqual(
    a.id,
    resourceQuery('dispatch.candidates', { machines: ['mini'], model: 'xai/grok-4.7' }).id,
  );
  assert.throws(() => resourceQuery('dispatch.candidates', { token: 'invalid' }), /owner fields/);
});

test('ticket matching is retained across flow changes only for Jira', () => {
  const jira = resourceQuery('dispatch.matchProject', { ticketOrPr: 'TAT-4355', flowType: 'dev' });
  assert.equal(jira.persisted, true);
  assert.equal(
    jira.id,
    resourceQuery('dispatch.matchProject', { ticketOrPr: 'TAT-4355', flowType: 'fix-bug' }).id,
  );
  assert.notEqual(
    resourceQuery('dispatch.matchProject', { ticketOrPr: 'fix/source', flowType: 'dev' }).id,
    resourceQuery('dispatch.matchProject', { ticketOrPr: 'fix/source', flowType: 'pr-complete' })
      .id,
  );
});

test('a branch beginning like a Jira key retains its PR flow', () => {
  const ref = 'feat-123-description';
  const query = resourceQuery('dispatch.matchProject', {
    ticketOrPr: ref,
    flowType: 'pr-complete',
  });
  assert.deepEqual(query.params, { ticketOrPr: ref, flowType: 'pr-complete' });
});

test('lowercase Jira-lookalike branches retain flow, while real browse URLs do not', () => {
  for (const ref of ['fix-123', 'release-7.70.0'])
    assert.deepEqual(
      resourceQuery('dispatch.matchProject', { ticketOrPr: ref, flowType: 'pr-complete' }).params,
      { ticketOrPr: ref, flowType: 'pr-complete' },
    );
  const url = 'https://consensys.atlassian.net/browse/TAT-4355?focusedCommentId=1';
  assert.deepEqual(
    resourceQuery('dispatch.matchProject', { ticketOrPr: url, flowType: 'dev' }).params,
    { ticketOrPr: url },
  );
});
