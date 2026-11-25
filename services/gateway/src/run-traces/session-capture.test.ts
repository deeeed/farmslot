import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

let tracesEnabled: boolean | undefined = true;
const captures: Array<{ kind: string; runId: string; contextId: string; answersRound?: number }> =
  [];
let failCapture = false;
const fleet = await import('../fleet/state.js');
mock.module('../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadProjectConfig: async () =>
      tracesEnabled === undefined ? {} : { traces: { enabled: tracesEnabled } },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async (slotId: string) => ({ host: 'localhost', machine: slotId }),
  },
});
const archive = await import('../runners/session-archive.js');
mock.module('../runners/session-archive.js', {
  namedExports: {
    ...archive,
    captureRunnerSession: async (params: {
      runId: string;
      contextId: string;
      answersRound?: number;
    }) => {
      if (failCapture) throw new Error('node unreachable');
      captures.push({ kind: 'end', ...params });
      return undefined;
    },
    captureRunnerSessionBeforeReplay: async (params: { runId: string; contextId: string }) => {
      if (failCapture) throw new Error('node unreachable');
      captures.push({ kind: 'replay', ...params });
      return undefined;
    },
  },
});
const store = await import('../runs/store.js');
const runs = new Map<string, Run>();
mock.module('../runs/store.js', {
  namedExports: { ...store, getRun: (id: string) => runs.get(id) },
});
const {
  captureSessionAtEnd,
  captureSessionBeforeReplay,
  tracesEnabled: enabledFor,
} = await import('./session-capture.js');

function run(id: string, slotId: string | null = 'slot-1'): Run {
  const value: Run = { ...makeRun({ id, project: 'farm', flowType: 'dev' }), slotId };
  runs.set(id, value);
  return value;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a session-end capture archives the worker by default and a named context on request', async () => {
  captures.length = 0;
  run('run-a');
  captureSessionAtEnd({ runId: 'run-a' });
  captureSessionAtEnd({ runId: 'run-a', contextId: 'review-fix', answersRound: 2 });
  await settle();
  assert.deepEqual(
    captures.map(({ kind, contextId, answersRound }) => ({ kind, contextId, answersRound })),
    [
      { kind: 'end', contextId: 'dev', answersRound: undefined },
      { kind: 'end', contextId: 'review-fix', answersRound: 2 },
    ],
  );
});

test('a project with traces.enabled false archives nothing at session end or replay', async () => {
  captures.length = 0;
  tracesEnabled = false;
  try {
    run('run-b');
    assert.equal(await enabledFor('farm'), false);
    captureSessionAtEnd({ runId: 'run-b' });
    await captureSessionBeforeReplay({ runId: 'run-b' });
    await settle();
    assert.deepEqual(captures, []);
  } finally {
    tracesEnabled = true;
  }
});

test('traces are on when the project does not mention them', async () => {
  tracesEnabled = undefined;
  try {
    assert.equal(await enabledFor('farm'), true);
  } finally {
    tracesEnabled = true;
  }
});

test('a run without a slot is left to the release backstop', async () => {
  captures.length = 0;
  run('run-c', null);
  captureSessionAtEnd({ runId: 'run-c' });
  await captureSessionBeforeReplay({ runId: 'run-c' });
  await settle();
  assert.deepEqual(captures, []);
});

test('a failed capture never reaches the caller', async () => {
  failCapture = true;
  try {
    run('run-d');
    assert.doesNotThrow(() => captureSessionAtEnd({ runId: 'run-d' }));
    await captureSessionBeforeReplay({ runId: 'run-d' });
    await settle();
  } finally {
    failCapture = false;
  }
});

test('a pre-replay capture archives the worker it replaces', async () => {
  captures.length = 0;
  run('run-e');
  await captureSessionBeforeReplay({ runId: 'run-e' });
  assert.deepEqual(
    captures.map(({ kind, contextId }) => ({ kind, contextId })),
    [{ kind: 'replay', contextId: 'dev' }],
  );
});
