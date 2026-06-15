import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseTmuxKeys,
  selectResolvedTmuxSession,
  shellQuote,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from './tmux.js';

describe('shellQuote', () => {
  it('wraps strings for safe single-quoted shell usage', () => {
    assert.equal(shellQuote(`foo'bar`), `'foo'\\''bar'`);
  });
});

describe('tmuxShellSnippet', () => {
  it('resolves tmux via PATH or fallback locations before running the snippet', () => {
    const snippet = tmuxShellSnippet(`capture-pane -t 'mme-1' -p`);
    assert.match(snippet, /command -v tmux/);
    assert.match(snippet, /\/opt\/homebrew\/bin\/tmux/);
    assert.match(snippet, /"\$TMUX_BIN" capture-pane -t 'mme-1' -p$/);
  });
});

describe('parseTmuxKeys', () => {
  it('splits space-separated tmux key names and drops empty segments', () => {
    assert.deepEqual(parseTmuxKeys('  C-c   Enter  '), ['C-c', 'Enter']);
  });
});

describe('tmuxSendTextCommand', () => {
  it('submits literal text with Enter when enter is requested', () => {
    const command = tmuxSendTextCommand('mm-1:bugfix', 'echo ok', { enter: true });

    assert.match(command, /send-keys -t 'mm-1:bugfix' -l 'echo ok'/);
    assert.match(command, /send-keys -t 'mm-1:bugfix' Enter/);
    assert.doesNotMatch(command, /send-keys -t 'mm-1:bugfix' C-m/);
  });
});

describe('selectResolvedTmuxSession', () => {
  it('uses the unique pane-path match when exactly one live session matches', () => {
    assert.equal(selectResolvedTmuxSession('mm-1', ['example-mobile-1']), 'example-mobile-1');
  });

  it('falls back to the configured session when pane-path matches are ambiguous', () => {
    assert.equal(selectResolvedTmuxSession('mm-1', ['example-mobile-1', 'shadow-session']), 'mm-1');
  });
});
