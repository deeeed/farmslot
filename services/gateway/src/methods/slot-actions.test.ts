import assert from 'node:assert/strict';
import test from 'node:test';

import type { RawProjectJson } from '../core/config.js';

import { collectSlotActions, normalizeExecExitCode } from './slot-actions.js';

test('collectSlotActions normalizes top-level run and copy actions', () => {
  const actions = collectSlotActions({
    slot_actions: {
      refresh: {
        label: 'Refresh',
        command: 'bash temp/runtime/safe-refresh.sh',
        timeout_ms: 120000,
        refresh: ['resources'],
      },
      copy: {
        label: 'Copy refresh',
        mode: 'copy',
        command: 'bash temp/runtime/safe-refresh.sh',
      },
    },
  } as RawProjectJson).map((action) => action.summary);

  assert.deepEqual(actions, [
    {
      id: 'slot:refresh',
      label: 'Refresh',
      mode: 'run',
      style: 'secondary',
      placement: ['slot-header'],
      refresh: ['resources'],
    },
    {
      id: 'slot:copy',
      label: 'Copy refresh',
      mode: 'copy',
      style: 'secondary',
      placement: ['slot-header'],
      refresh: ['none'],
    },
  ]);
});

test('collectSlotActions scopes resource action ids and defaults placement to resource panel', () => {
  const actions = collectSlotActions({
    resources: {
      browser: {
        type: 'browser',
        label: 'Browser',
        actions: {
          fullscreen: {
            label: 'Full',
            command: 'launch',
            style: 'primary',
          },
        },
      },
    },
  } as RawProjectJson);

  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].summary, {
    id: 'resource:browser:fullscreen',
    label: 'Full',
    mode: 'run',
    style: 'primary',
    placement: ['resource-panel'],
    refresh: ['resources'],
    resourceId: 'browser',
  });
});

test('collectSlotActions ignores malformed ids and definitions', () => {
  const actions = collectSlotActions({
    slot_actions: {
      'bad:id': { label: 'Bad', command: 'echo bad' },
      missingCommand: { label: 'Missing' } as never,
      ok: { label: 'OK', command: 'echo ok' },
    },
  } as RawProjectJson);

  assert.deepEqual(
    actions.map((action) => action.summary.id),
    ['slot:ok'],
  );
});

test('normalizeExecExitCode treats signal/string exits as failures', () => {
  assert.equal(normalizeExecExitCode(0), 0);
  assert.equal(normalizeExecExitCode(2), 2);
  assert.equal(normalizeExecExitCode('SIGTERM'), 1);
  assert.equal(normalizeExecExitCode(undefined, 'SIGTERM'), 1);
  assert.equal(normalizeExecExitCode(undefined, undefined, true), 1);
});
