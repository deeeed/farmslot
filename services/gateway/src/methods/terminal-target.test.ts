import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { requestedWindowName } from './terminal.js';

/**
 * tmux resolves `session:missing-window` to the session's CURRENT window and
 * exits 0. A readiness probe that only checks the exit code therefore cannot
 * tell a live role window from one that dispatch's `pane-died -> kill-pane`
 * hook destroyed — which is how a reopen command was typed into the `worker`
 * window while the gateway kept reporting the session dead.
 */
test('a session:window target names the window that must be compared', () => {
  assert.equal(requestedWindowName('ff-1:dev'), 'dev');
  assert.equal(requestedWindowName('ff-1:rev2-codex'), 'rev2-codex');
  assert.equal(requestedWindowName('ff-1:dev.2'), 'dev');
});

test('targets with no comparable window name are left alone', () => {
  // A bare session legitimately means "wherever the session is pointing".
  assert.equal(requestedWindowName('ff-1'), null);
  // tmux reports names for `#{window_name}`, so an index cannot be compared.
  assert.equal(requestedWindowName('ff-1:3'), null);
  // Pane and window ids address a pane directly and fail on their own if gone.
  assert.equal(requestedWindowName('%17'), null);
  assert.equal(requestedWindowName('@42'), null);
  assert.equal(requestedWindowName('ff-1:'), null);
});

const GATEWAY_SRC = path.resolve(import.meta.dirname, '..');

test('the interactive readiness probe compares the resolved window name', () => {
  const source = readFileSync(path.join(GATEWAY_SRC, 'methods/terminal.ts'), 'utf8');

  assert.match(source, /#\{window_name\}/);
  assert.match(source, /result\.stdout\.trim\(\) === requestedWindow/);
  // The old probe threw away the answer and only read the exit code.
  assert.doesNotMatch(source, /'#\{session_name\}' >\/dev\/null 2>&1/);
});

test('every tmux key delivery path fails loudly when tmux refuses the send', () => {
  const streamSource = readFileSync(path.join(GATEWAY_SRC, 'runtime/tmux-stream.ts'), 'utf8');
  const controlSource = readFileSync(path.join(GATEWAY_SRC, 'methods/tmux-control.ts'), 'utf8');

  // Both paths used to discard the exec result, so `can't find window: dev`
  // was reported to the caller as a successful delivery.
  for (const [name, source] of [
    ['tmux-stream sendKeys', streamSource],
    ['tmux-control tmuxSendKeys', controlSource],
  ] as const) {
    assert.match(source, /tmux send-keys to .* failed/, `${name} must throw on a refused send`);
    assert.match(source, /result\.exitCode !== 0/, `${name} must inspect the exit code`);
  }
});

/**
 * A multi-kilobyte command typed as keystrokes is chunked, and a shell can be
 * left mid-token at a continuation prompt with nothing executed. Paste is one
 * buffer write and one paste.
 */
function functionBody(source: string, signature: string): string {
  const fn = source.slice(source.indexOf(signature));
  return fn.slice(0, fn.indexOf('\n}\n') + 3);
}

test('pasted text is delivered as one bracketed paste buffer, not typed keys', () => {
  const core = readFileSync(path.join(GATEWAY_SRC, 'core/tmux.ts'), 'utf8');
  const control = readFileSync(path.join(GATEWAY_SRC, 'methods/tmux-control.ts'), 'utf8');
  const primitive = functionBody(core, 'export async function pasteTmuxText');
  const pasteText = functionBody(control, 'export async function tmuxPasteText');

  assert.match(primitive, /set-buffer -b /);
  // `-p` brackets the paste so the shell does not run on an embedded newline.
  assert.match(primitive, /paste-buffer -d -p -b /);
  // The text never goes through send-keys, which chunks and truncates.
  assert.doesNotMatch(primitive, /send-keys/);
  // Every tmux step is checked; a refused paste must not report success.
  assert.match(primitive, /set-buffer for .* failed/);
  assert.match(primitive, /paste-buffer to .* failed/);
  assert.match(pasteText, /pasteTmuxText\(vars, target, params\.text\)/);
  assert.match(pasteText, /submit to .* failed/);
});

test('long runner input from terminal.send is pasted and submitted with the runner key', () => {
  const stream = readFileSync(path.join(GATEWAY_SRC, 'runtime/tmux-stream.ts'), 'utf8');
  const body = functionBody(stream, 'export async function sendKeys');

  assert.match(
    body,
    /if \(sendsRunnerInputAsPaste\(text, runner\)\) \{\n\s+await pasteTmuxText\(vars, session, text\);/,
  );
  assert.match(
    body,
    /send-keys -t \$\{shellQuote\(session\)\} \$\{runnerPromptSubmitKey\(runner\)\}/,
  );
  assert.match(body, /submit\.exitCode !== 0/);
});

test('the paste buffer is named uniquely and deleted after use', () => {
  const source = readFileSync(path.join(GATEWAY_SRC, 'core/tmux.ts'), 'utf8');

  // A shared buffer name would collide between concurrent slots, and a retained
  // buffer would leave a multi-kilobyte command in the slot's paste stack.
  assert.match(source, /farmslot-paste-\$\{randomUUID\(\)\}/);
  assert.match(source, /delete-buffer -b /);
});
