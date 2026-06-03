import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSendKeysCommand } from './tmux-stream.js';

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
