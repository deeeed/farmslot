import assert from 'node:assert/strict';
import test from 'node:test';

import { mountHook } from '../../hooks/hook-harness.fixtures';
import type { TerminalControlKey } from '../../lib/terminal-controls';

type ControlKeys = {
  press: (control: TerminalControlKey) => void;
  busy: boolean;
  activeLabel: string | null;
};

// Arthur's rule: a keystroke is never dropped. The slot key bar ignored presses while one was out.
test('key-bar presses made while a key is on its way all go out, in the order pressed', async () => {
  const sent: string[] = [];
  const replies: Array<() => void> = [];
  const send = (control: TerminalControlKey) => {
    sent.push(control.label);
    return new Promise<void>((resolve) => replies.push(resolve));
  };
  const hook = mountHook<[typeof send]>(
    new URL('./use-terminal-control-keys.ts', import.meta.url),
    'useTerminalControlKeys',
    {},
  );
  try {
    const keys = (label: string): TerminalControlKey => ({ label, data: label, danger: false });
    let bar = hook.render(send) as ControlKeys;
    bar.press(keys('↓'));
    bar = hook.render(send) as ControlKeys;
    bar.press(keys('↓'));
    bar.press(keys('Enter'));
    assert.deepEqual(sent, ['↓', '↓', 'Enter']);
    bar = hook.render(send) as ControlKeys;
    assert.equal(bar.busy, true);
    assert.equal(bar.activeLabel, '↓');

    replies.forEach((reply) => reply());
    await new Promise<void>((resolve) => setImmediate(resolve));
    bar = hook.render(send) as ControlKeys;
    assert.equal(bar.busy, false);
    assert.equal(bar.activeLabel, null);
  } finally {
    hook.cleanup();
  }
});
