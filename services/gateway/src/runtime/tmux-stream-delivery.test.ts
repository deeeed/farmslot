import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const vars = { machine: 'delivery-test' };
let pasteFailure: Error | undefined;
let submissionConfirmed = true;
let submissionFailure: Error | undefined;
const submitPrompt = mock.fn(async (..._args: unknown[]) => {
  if (submissionFailure) throw submissionFailure;
  if (!submissionConfirmed) throw new Error('Runner submission was not confirmed');
});
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
mock.module('../runners/registry.js', {
  namedExports: { runnerPromptSubmitKey: submitKey, sendRunnerPrompt: submitPrompt },
});
const { sendKeys } = await import('./tmux-stream.js');

beforeEach(() => {
  paste.mock.resetCalls();
  execute.mock.resetCalls();
  buildRaw.mock.resetCalls();
  submitKey.mock.resetCalls();
  pasteFailure = undefined;
  submissionConfirmed = true;
  submissionFailure = undefined;
  submitPrompt.mock.resetCalls();
  rawResult = { stdout: '', stderr: '', exitCode: 0 };
});

test('semantic text uses the shared runner submission owner', async () => {
  await sendKeys('slot', 'pane', 'message', true, 'grok');
  assert.deepEqual(submitPrompt.mock.calls[0].arguments, [vars, 'pane', 'grok', 'message']);
  assert.equal(paste.mock.callCount(), 0);
  assert.equal(execute.mock.callCount(), 0);
});

test('semantic enter:false does not select a submit key', async () => {
  await sendKeys('slot', 'pane', 'draft', false, 'claude');
  assert.deepEqual(paste.mock.calls[0].arguments, [vars, 'pane', 'draft']);
  assert.equal(submitKey.mock.callCount(), 0);
});

test('empty semantic submit stays in the serialized helper without text', async () => {
  await sendKeys('slot', 'pane', '', true, 'claude');
  assert.deepEqual(submitPrompt.mock.calls[0].arguments, [vars, 'pane', 'claude', '']);
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

test('submission failures propagate without falling back to typed input', async () => {
  submissionFailure = new Error('submission refused');
  await assert.rejects(
    sendKeys('slot', 'pane', 'message', true, 'claude'),
    (error) => error === submissionFailure,
  );
  assert.equal(execute.mock.callCount(), 0);
});

test('raw transport refusals still fail the request', async () => {
  rawResult = { stdout: '', stderr: 'typed refused', exitCode: 1 };
  await assert.rejects(sendKeys('slot', 'pane', 'message', true), /typed refused/);
});

test('long semantic input cannot succeed when the runner has not accepted it', async () => {
  submissionConfirmed = false;
  await assert.rejects(
    sendKeys('slot', 'pane', 'Continue the retained review.\n'.repeat(80), true, 'codex'),
    /submission.*not confirmed/i,
  );
});
