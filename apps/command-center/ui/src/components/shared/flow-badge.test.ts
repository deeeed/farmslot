import assert from 'node:assert/strict';
import test from 'node:test';

import { flowColor, flowLabel } from '@farmslot/theme';

import { flowBadgePresentation } from './flow-badge.js';

test('flow badge presentation reuses the shared flow palette and labels', () => {
  assert.deepEqual(flowBadgePresentation('fix-bug'), {
    color: flowColor('fix-bug'),
    label: flowLabel('fix-bug'),
    title: 'Flow: fix-bug',
  });
  assert.deepEqual(flowBadgePresentation('dev'), {
    color: flowColor('dev'),
    label: flowLabel('dev'),
    title: 'Flow: dev',
  });
});

test('flow badge presentation supports run-specific display overrides', () => {
  assert.deepEqual(
    flowBadgePresentation('dev', {
      color: '#123456',
      label: 'EVAL',
      title: 'Eval Candidate',
    }),
    {
      color: '#123456',
      label: 'EVAL',
      title: 'Eval Candidate',
    },
  );
});
