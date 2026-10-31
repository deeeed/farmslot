import assert from 'node:assert/strict';
import test from 'node:test';

import { mountHook } from '../../hooks/hook-harness.fixtures';
import * as inputQueue from '../../lib/terminal-input-queue';

type Typing = { typeKeys: (data: string) => void };
type Options = {
  connected: boolean;
  target: object;
  targetRef: { current: object };
  disabledReason: null;
  requireTarget: () => { current: () => boolean };
  setControlError: () => void;
  setInputError: (message: string) => void;
  onKeysDropped: () => void;
  commandCount: { current: number };
};

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// The input line mirrors what the pane was sent: after a drop it would edit keys the pane lacks.
test('keys dropped for good reset the input line and say why; keys sent leave it', async () => {
  let outcome: Promise<void> = Promise.resolve();
  const hook = mountHook<[Options]>(
    new URL('./use-slot-terminal-typing.ts', import.meta.url),
    'useSlotTerminalTyping',
    {
      'expo-haptics': { impactAsync: async () => {}, ImpactFeedbackStyle: {} },
      '../../lib/terminal-input-queue': inputQueue,
      './use-terminal-control-keys': { useTerminalControlKeys: () => ({}) },
      './use-terminal-input': { useTerminalInput: () => ({ write: () => outcome }) },
    },
  );
  try {
    const resets: number[] = [];
    const errors: string[] = [];
    const target = { slotId: 'mmt-3' };
    const typing = hook.render({
      connected: true,
      target,
      targetRef: { current: target },
      disabledReason: null,
      requireTarget: () => ({ current: () => true }),
      setControlError: () => {},
      setInputError: (message) => errors.push(message),
      onKeysDropped: () => resets.push(1),
      commandCount: { current: 0 },
    }) as Typing;
    typing.typeKeys('ls');
    await flush();
    assert.deepEqual(resets, []);
    outcome = Promise.reject(new inputQueue.TerminalInputMaybeTypedError(new Error('timed out')));
    typing.typeKeys('\r');
    await flush();
    assert.deepEqual(resets, [1]);
    assert.match(errors[0] ?? '', /may have reached the terminal/);
    // Leaving the terminal is not a drop: the line goes with it.
    outcome = Promise.reject(new inputQueue.TerminalInputCancelledError());
    typing.typeKeys('x');
    await flush();
    assert.deepEqual(resets, [1]);
  } finally {
    hook.cleanup();
  }
});
