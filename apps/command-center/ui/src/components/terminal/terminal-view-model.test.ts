import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  extractOsc52Clipboard,
  parseWorkerRef,
  terminalMatchesTarget,
  terminalRoleExitDecision,
  terminalTargetLabel,
  terminalTargetParams,
} from './terminal-view-model.js';

test('parseWorkerRef preserves optional tmux coordinates and rejects malformed refs', () => {
  const worker = parseWorkerRef(
    JSON.stringify({
      nodeId: 'runner-a',
      session: 'farm',
      target: 'worker',
      window: 2,
      windowName: 'dev',
      pane: 1,
      paneId: '%7',
    }),
  );
  assert.deepEqual(worker, {
    nodeId: 'runner-a',
    session: 'farm',
    target: 'worker',
    window: 2,
    windowName: 'dev',
    pane: 1,
    paneId: '%7',
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(parseWorkerRef('{bad json'), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(parseWorkerRef(JSON.stringify({ nodeId: 'runner-a' })), null);
});

test('terminal target helpers derive worker, role-bound, and postmortem routing', () => {
  const worker = parseWorkerRef(JSON.stringify({ nodeId: 'node-1', session: 's', target: 't' }));
  assert.equal(terminalTargetLabel({ slotId: '', worker }), 'node-1:s');
  assert.deepEqual(
    terminalTargetParams({
      slotId: '',
      runId: '',
      role: '',
      contextId: '',
      worker,
      postmortem: false,
    }),
    { worker },
  );
  assert.deepEqual(
    terminalTargetParams({
      slotId: 'slot-1',
      runId: 'run-1',
      role: 'dev',
      contextId: 'ctx',
      worker: null,
      postmortem: false,
    }),
    { slotId: 'slot-1', runId: 'run-1', role: 'dev', contextId: 'ctx' },
  );
  assert.deepEqual(
    terminalTargetParams({
      slotId: 'slot-1',
      runId: 'run-1',
      role: 'dev',
      contextId: 'ctx',
      worker: null,
      postmortem: true,
    }),
    { slotId: 'slot-1', bareSession: true },
  );
  assert.equal(
    terminalMatchesTarget(
      {
        slotId: 'slot-1',
        runId: 'run-1',
        role: 'dev',
        contextId: 'ctx',
        worker: null,
        postmortem: false,
      },
      { slotId: 'slot-1', runId: 'run-1', role: 'dev', contextId: 'ctx' },
    ),
    true,
  );
});

test('extractOsc52Clipboard strips BEL and ST terminated clipboard sequences', () => {
  const decode = (value: string) => Buffer.from(value, 'base64').toString('utf8');
  const result = extractOsc52Clipboard(
    `before\x1b]52;c;${Buffer.from('copy me').toString('base64')}\x07middle\x1b]52;p;${Buffer.from(
      'again',
    ).toString('base64')}\x1b\\after`,
    decode,
  );

  assert.equal(result.data, 'beforemiddleafter');
  assert.deepEqual(result.clipboardTexts, ['copy me', 'again']);
  assert.deepEqual(result.decodeErrors, []);
});

test('terminalRoleExitDecision preserves role fast-fail postmortem thresholds', () => {
  assert.deepEqual(
    terminalRoleExitDecision({
      exitCode: 1,
      subscribeOkAt: 1000,
      nowMs: 3999,
      fastFailMs: 3000,
      role: 'dev',
      contextId: '',
      postmortem: false,
    }),
    {
      elapsedSinceOk: 2999,
      nonZero: true,
      roleBound: true,
      fastFail: true,
      shouldLogRoleExit: true,
      shouldEnterPostmortem: true,
    },
  );

  assert.equal(
    terminalRoleExitDecision({
      exitCode: 1,
      subscribeOkAt: 1000,
      nowMs: 4000,
      fastFailMs: 3000,
      role: 'dev',
      contextId: '',
      postmortem: false,
    }).shouldEnterPostmortem,
    false,
  );
  assert.equal(
    terminalRoleExitDecision({
      exitCode: 0,
      subscribeOkAt: 1000,
      nowMs: 1100,
      fastFailMs: 3000,
      role: 'dev',
      contextId: '',
      postmortem: false,
    }).shouldLogRoleExit,
    false,
  );
  assert.equal(
    terminalRoleExitDecision({
      exitCode: 1,
      subscribeOkAt: 1000,
      nowMs: 1100,
      fastFailMs: 3000,
      role: '',
      contextId: '',
      postmortem: false,
    }).shouldEnterPostmortem,
    false,
  );
  assert.equal(
    terminalRoleExitDecision({
      exitCode: 1,
      subscribeOkAt: 1000,
      nowMs: 1100,
      fastFailMs: 3000,
      role: 'dev',
      contextId: '',
      postmortem: true,
    }).shouldEnterPostmortem,
    false,
  );
});

test('extractOsc52Clipboard strips malformed sequences and reports decode errors', () => {
  const bad = new Error('bad base64');
  const result = extractOsc52Clipboard('a\x1b]52;c;not-base64\x07b', () => {
    throw bad;
  });

  assert.equal(result.data, 'ab');
  assert.deepEqual(result.clipboardTexts, []);
  assert.deepEqual(result.decodeErrors, [bad]);
});
