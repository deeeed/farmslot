import assert from 'node:assert/strict';
import test from 'node:test';

import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { backlogExecutionDefaults } from './backlog-review-dispatch';

test('editing only a backlog title retains the project runner and model when overrides are absent', () => {
  const project = { name: 'project', defaults: { dev: { runner: 'claude', model: 'opus' } } };
  const item = {
    title: 'Before',
    runner: undefined,
    model: undefined,
    effort: undefined,
    reviewMode: undefined,
  };
  const before = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      defaults: backlogExecutionDefaults(project, 'dev', item),
    },
  }).toSelection();
  const editedItem = { ...item, title: 'After' };
  const after = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      defaults: backlogExecutionDefaults(project, 'dev', editedItem),
    },
  }).toSelection();
  assert.deepEqual(before, { runner: 'claude', model: 'opus', effort: null, mode: 'cold' });
  assert.deepEqual(after, before);
});

test('absent backlog overrides retain configured effort while defined selections take precedence', () => {
  const project = {
    name: 'project',
    defaults: { dev: { runner: 'codex', model: 'gpt-6-luna', effort: 'high' } },
  };
  const inherited = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      defaults: backlogExecutionDefaults(project, 'dev', { effort: undefined }),
    },
  }).toSelection();
  assert.deepEqual(inherited, {
    runner: 'codex',
    model: 'gpt-6-luna',
    effort: 'high',
    mode: 'cold',
  });
  const selected = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      defaults: backlogExecutionDefaults(project, 'dev', {
        runner: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'max',
        reviewMode: 'cold',
      }),
    },
  }).toSelection();
  assert.deepEqual(selected, {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'max',
    mode: 'cold',
  });
});

test('title edits preserve explicit runner-default model and effort from review configuration', () => {
  const project = {
    name: 'project',
    defaults: { 'review-pr': { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' } },
    review: { model: null, effort: null, mode: 'cold' as const },
  };
  const selection = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      defaults: backlogExecutionDefaults(project, 'review-pr', {
        runner: undefined,
        model: undefined,
        effort: undefined,
        reviewMode: undefined,
      }),
    },
  }).toSelection();
  assert.deepEqual(selection, { runner: 'codex', model: null, effort: null, mode: 'cold' });
});
