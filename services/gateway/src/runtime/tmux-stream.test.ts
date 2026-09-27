import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSendKeysCommand, sendsRunnerInputAsPaste } from './tmux-stream.js';

describe('buildSendKeysCommand', () => {
  it('returns the tmux send snippet directly without nesting tmuxShellSnippet', () => {
    const command = buildSendKeysCommand('slot-1', 'hello world');
    assert.match(command, /^TMUX_BIN=/);
    assert.doesNotMatch(command, /"\$TMUX_BIN" TMUX_BIN=/);
  });

  it('sends Enter as a second tmux command when requested', () => {
    const command = buildSendKeysCommand('slot-1', 'hello world', true);
    assert.equal((command.match(/send-keys -t 'slot-1'/g) ?? []).length, 2);
  });
});

describe('sendsRunnerInputAsPaste', () => {
  it('pastes semantic runner input of any size and leaves raw and submit-only input alone', () => {
    assert.equal(sendsRunnerInputAsPaste('ok', 'claude'), true);
    assert.equal(sendsRunnerInputAsPaste('x'.repeat(5_000), 'codex'), true);
    assert.equal(sendsRunnerInputAsPaste('ok', undefined), false);
    assert.equal(sendsRunnerInputAsPaste('', 'claude'), false);
  });
});
