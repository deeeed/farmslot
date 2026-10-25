import assert from 'node:assert/strict';
import { test } from 'node:test';

import { quickVoiceInstruction, quickVoiceMayStart, quickVoiceWorkerKey } from './quick-actions';

test('dictation retains the source run context until explicit Send', () => {
  assert.equal(
    quickVoiceInstruction('Run: retained-run-7', '  explain the stale result  '),
    'Run: retained-run-7\n\nexplain the stale result',
  );
  assert.equal(quickVoiceInstruction('Run: retained-run-7', '   '), '');
  assert.equal(quickVoiceInstruction('', 'check the output'), 'check the output');
});

test('voice handoff identity separates nodes and panes even for identical session names', () => {
  const ref = { nodeId: 'node-1', session: 'operator', target: '%7', paneId: '%7' };
  assert.notEqual(quickVoiceWorkerKey(ref), quickVoiceWorkerKey({ ...ref, nodeId: 'node-2' }));
  assert.notEqual(
    quickVoiceWorkerKey(ref),
    quickVoiceWorkerKey({ ...ref, target: '%8', paneId: '%8' }),
  );
  assert.equal(
    quickVoiceWorkerKey(ref),
    quickVoiceWorkerKey({ ...ref, windowName: 'renamed presentation' }),
  );
});

test('a pending gesture cannot start a retained old worker after the route target changes', () => {
  const intent = { key: 'worker-a', scope: 'profile-a' };
  const target = { key: 'worker-a', scope: 'profile-a', ready: true };
  assert.equal(
    quickVoiceMayStart({ intent, target, currentScope: 'profile-a', currentWorkerKey: 'worker-a' }),
    true,
  );
  assert.equal(
    quickVoiceMayStart({ intent, target, currentScope: 'profile-a', currentWorkerKey: 'worker-b' }),
    false,
  );
  assert.equal(
    quickVoiceMayStart({ intent, target, currentScope: 'profile-b', currentWorkerKey: 'worker-a' }),
    false,
  );
  assert.equal(
    quickVoiceMayStart({
      intent,
      target: { ...target, ready: false },
      currentScope: 'profile-a',
      currentWorkerKey: 'worker-a',
    }),
    false,
  );
});
