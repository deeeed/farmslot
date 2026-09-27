import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const vars = { machine: 'delivery-test' };
let pasteFailure: Error | undefined;
let rawResult = { stdout: '', stderr: '', exitCode: 0 };
const paste = mock.fn(async (..._args: unknown[]) => {
  if (pasteFailure) throw pasteFailure;
});
const execute = mock.fn(async (..._args: unknown[]) => rawResult);
const buildRaw = mock.fn((..._args: unknown[]) => 'raw-command');
const submitKey = mock.fn((runner: string) => (runner === 'grok' ? 'C-m' : 'Enter'));

mock.module('../core/config.js', { namedExports: { loadSlotVars: async () => vars } });
mock.module('../core/exec.js', { namedExports: { execOnSlot: execute } });
mock.module('../core/tmux.js', {
  namedExports: {
    pasteTmuxText: paste,
    shellQuote: JSON.stringify,
    tmuxSendTextCommand: buildRaw,
    tmuxShellSnippet: (command: string) => command,
  },
});
mock.module('../runners/registry.js', { namedExports: { runnerPromptSubmitKey: submitKey } });
const { sendKeys } = await import('./tmux-stream.js');

beforeEach(() => {
  paste.mock.resetCalls();
  execute.mock.resetCalls();
  buildRaw.mock.resetCalls();
  submitKey.mock.resetCalls();
  pasteFailure = undefined;
  rawResult = { stdout: '', stderr: '', exitCode: 0 };
});

test('semantic text uses paste and the resolved runner submit key', async () => {
  await sendKeys('slot', 'pane', 'message', true, 'grok');
  assert.deepEqual(paste.mock.calls[0].arguments, [vars, 'pane', 'message', { submitKey: 'C-m' }]);
  assert.deepEqual(submitKey.mock.calls[0].arguments, ['grok']);
  assert.equal(execute.mock.callCount(), 0);
});

test('semantic enter:false does not select a submit key', async () => {
  await sendKeys('slot', 'pane', 'draft', false, 'claude');
  assert.deepEqual(paste.mock.calls[0].arguments, [
    vars,
    'pane',
    'draft',
    { submitKey: undefined },
  ]);
  assert.equal(submitKey.mock.callCount(), 0);
});

test('empty semantic submit stays in the serialized helper without text', async () => {
  await sendKeys('slot', 'pane', '', true, 'claude');
  assert.deepEqual(paste.mock.calls[0].arguments, [vars, 'pane', '', { submitKey: 'Enter' }]);
  assert.equal(execute.mock.callCount(), 0);
});

test('raw operator input retains the typed path and timeout', async () => {
  await sendKeys('slot', 'pane', 'raw', true);
  assert.equal(paste.mock.callCount(), 0);
  assert.equal(submitKey.mock.callCount(), 0);
  assert.deepEqual(buildRaw.mock.calls[0].arguments, [
    'pane',
    'raw',
    { enter: true, submitKey: 'Enter' },
  ]);
  assert.deepEqual(execute.mock.calls[0].arguments, [vars, 'raw-command', { timeout: 5000 }]);
});

test('raw enter:false does not request submission', async () => {
  await sendKeys('slot', 'pane', 'raw', false);
  assert.deepEqual(buildRaw.mock.calls[0].arguments, ['pane', 'raw']);
  assert.equal(paste.mock.callCount(), 0);
});

test('paste failures propagate without falling back to typed input', async () => {
  pasteFailure = new Error('paste refused');
  await assert.rejects(
    sendKeys('slot', 'pane', 'message', true, 'claude'),
    (error) => error === pasteFailure,
  );
  assert.equal(execute.mock.callCount(), 0);
});

test('raw transport refusals still fail the request', async () => {
  rawResult = { stdout: '', stderr: 'typed refused', exitCode: 1 };
  await assert.rejects(sendKeys('slot', 'pane', 'message', true), /typed refused/);
});
