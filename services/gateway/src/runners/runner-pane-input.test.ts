import assert from 'node:assert/strict';
import test from 'node:test';

import { runnerPaneBufferedInstruction } from './runner-pane-input.js';

const boxed = (body: string) => `${'─'.repeat(40)}\n❯ ${body}\n${'─'.repeat(40)}\n  farm status`;

test('a dim prompt suggestion in an empty composer is not a draft', () => {
  assert.equal(runnerPaneBufferedInstruction(boxed('\x1b[2mOpen the task PR.\x1b[0m')), '');
});

test('a wrapped dim suggestion in an empty composer is not a draft', () => {
  assert.equal(
    runnerPaneBufferedInstruction(
      boxed('\x1b[2mOpen the task PR with\n  the completed proof.\x1b[0m'),
    ),
    '',
  );
});

for (const body of [
  'operator draft',
  '\x1b[38;5;244moperator draft\x1b[0m',
  '\x1b[38;2;100;140;200moperator draft\x1b[0m',
  'operator \x1b[2mdraft\x1b[0m',
]) {
  test(`actual composer input stays protected: ${JSON.stringify(body)}`, () => {
    assert.equal(runnerPaneBufferedInstruction(boxed(body)), 'operator draft');
  });
}

test('a wholly dim prompt row stays protected when its style is ambiguous', () => {
  const row = `\x1b[2m${boxed('operator draft')}\x1b[0m`;
  assert.equal(runnerPaneBufferedInstruction(row), 'operator draft');
});
