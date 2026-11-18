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

test('Codex 0.170 keeps its model and directory row when a draft hides the shortcuts', () => {
  const tail = [
    '› Previous submitted prompt',
    '',
    '› Current operator draft',
    '',
    '  GPT-6.2-Sol high · /private/tmp/codex-enter-proof',
  ].join('\n');
  assert.equal(runnerPaneBufferedInstruction(tail), 'Current operator draft');
});

test('an explicit shortcut footer after the live prompt still ends the draft', () => {
  const tail = [
    '› Current operator draft',
    '',
    '  ← for agents · ? for shortcuts',
    '',
    '  GPT-6.2-Sol high · /private/tmp/codex-enter-proof',
  ].join('\n');
  assert.equal(runnerPaneBufferedInstruction(tail), 'Current operator draft');
});

test('a shortcut footer from an older inline frame cannot hide the current Codex draft', () => {
  const tail = [
    '› Ask Codex to do anything',
    '',
    '  ← for agents · ? for shortcuts',
    '',
    '› Current operator draft',
    '',
    '  GPT-6.2-Sol high · /private/tmp/codex-enter-proof',
  ].join('\n');
  assert.equal(runnerPaneBufferedInstruction(tail), 'Current operator draft');
});

test('shortcut or context wording on the Codex prompt row does not end the draft', () => {
  const draft = 'Explain the context left indicator';
  const tail = `› ${draft}\n\n  GPT-6.2-Sol high · /tmp/codex-enter-proof`;
  assert.equal(runnerPaneBufferedInstruction(tail), draft);
});
