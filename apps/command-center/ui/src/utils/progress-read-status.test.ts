import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskProgressResult } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import { progressReadNotice } from './progress-read-status.js';

const data: TaskProgressResult = { slotId: 'slot', markdown: '- [x] Proof' };
test('loading, ready, empty saved data, absent watches and changing reads stay quiet', () => {
  const quiet: ResourceQueryState<TaskProgressResult>[] = [
    { status: 'loading' },
    { status: 'ready', data },
    { status: 'stale', data: { slotId: 'slot', markdown: '' }, observedAt: 1 },
    {
      status: 'stale',
      data: { slotId: 'slot', markdown: '# Task, no checklist yet' },
      observedAt: 1,
    },
    { status: 'unsupported' },
    { status: 'unsupported', data, observedAt: 1 },
    ...[
      'RESOURCE_OBSERVATION_UNSUPPORTED',
      'RESOURCE_OBSERVATION_UNAVAILABLE',
      'PROGRESS_OWNER_CHANGED',
      'RESOURCE_OBSERVATION_CHANGED',
    ].map(
      (code): ResourceQueryState<TaskProgressResult> => ({
        status: 'error',
        error: { code, message: 'No current watch' },
      }),
    ),
  ];
  for (const state of quiet) assert.equal(progressReadNotice(state), undefined);
});

test('a real failure has one short message and keeps its cause out of the line', () => {
  for (const saved of [undefined, data]) {
    const notice = progressReadNotice({
      status: 'error',
      data: saved,
      error: { code: 'RESOURCE_OBSERVATION_FAILED', message: 'Long backend failure details' },
    });
    assert.deepEqual(notice, {
      kind: 'error',
      text: 'Could not read progress',
      detail: 'Long backend failure details',
    });
  }
});

test('retained real progress is labelled, while an offline empty read stays quiet', () => {
  assert.deepEqual(progressReadNotice({ status: 'stale', data, observedAt: 1 }, false), {
    kind: 'saved',
    text: 'Saved progress',
  });
  assert.equal(
    progressReadNotice(
      { status: 'error', error: { code: 'CONNECTION_LOST', message: 'Offline' } },
      false,
    ),
    undefined,
  );
});
