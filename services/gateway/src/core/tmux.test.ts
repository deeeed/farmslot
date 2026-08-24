import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTmuxRespawnLaunchCommand,
  parseTmuxKeys,
  respawnTmuxPaneWithCommand,
  selectExactTmuxWindowPane,
  selectResolvedTmuxSession,
  shellQuote,
  tmuxDiscoveryFailedResult,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from './tmux.js';

describe('buildTmuxRespawnLaunchCommand', () => {
  it('returns a primary worker to its repo shell after the runner exits', () => {
    const command = buildTmuxRespawnLaunchCommand(
      'claude --resume session-id',
      '/tmp/mobile 3',
      true,
    );

    assert.match(command, /bash -lc/);
    assert.match(command, /claude/);
    assert.match(command, /cd .*mobile 3/);
    assert.match(command, /exec .*shell:-\/bin\/sh/);
    assert.doesNotMatch(command, /^exec bash -lc/);
  });

  it('lets a disposable reviewer window exit with the runner', () => {
    assert.equal(
      buildTmuxRespawnLaunchCommand('codex review', '/tmp/reviewer'),
      `exec bash -lc 'codex review'`,
    );
  });
});

describe('respawnTmuxPaneWithCommand', () => {
  it('rejects a window target so callers cannot kill sibling panes', async () => {
    await assert.rejects(
      () => respawnTmuxPaneWithCommand({} as never, 'ff-1:dev', 'codex resume session'),
      /Invalid exact tmux pane id/,
    );
  });
});

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
    assert.doesNotMatch(command, /sleep/);
  });

  it('inserts only the requested bounded delay between literal text and submit', () => {
    const literal = tmuxShellSnippet(`send-keys -t 'ff-1:dev' -l '/exit'`);
    const submit = tmuxShellSnippet(`send-keys -t 'ff-1:dev' Enter`);
    assert.equal(
      tmuxSendTextCommand('ff-1:dev', '/exit', { enter: true, submitDelayMs: 50 }),
      `${literal}\nsleep 0.05\n${submit}`,
    );
    assert.throws(
      () => tmuxSendTextCommand('ff-1:dev', '/exit', { enter: true, submitDelayMs: 1_001 }),
      /integer between 0 and 1000/,
    );
  });
});

describe('tmuxDiscoveryFailedResult', () => {
  it('maps node RPC timeouts to a failed probe instead of throwing', () => {
    const mapped = tmuxDiscoveryFailedResult(new Error('Node macpro timeout after 3000ms'));
    assert.deepEqual(mapped, {
      stdout: '',
      stderr: 'Node macpro timeout after 3000ms',
      exitCode: 124,
    });
  });

  it('maps disconnects the same way so discovery can fall back to the configured session', () => {
    assert.equal(
      tmuxDiscoveryFailedResult(new Error('Node macpro WebSocket not open'))?.exitCode,
      124,
    );
    assert.equal(
      tmuxDiscoveryFailedResult(new Error('No node connected for machine macpro after 15000ms'))
        ?.exitCode,
      124,
    );
  });

  it('does not swallow unrelated exec failures', () => {
    assert.equal(tmuxDiscoveryFailedResult(new Error('tmux not found')), null);
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

describe('selectExactTmuxWindowPane', () => {
  it('does not bind a missing reviewer window to a prefixed sibling', () => {
    const panes = [
      'ff-1\trev2-claude\t%21\t2001',
      'ff-1\trev-claude\t%22\t2002',
      'ff-2\trev-claude\t%23\t2003',
    ].join('\n');

    assert.deepEqual(selectExactTmuxWindowPane(panes, 'ff-1', 'rev-claude'), {
      paneId: '%22',
      panePid: '2002',
    });
    assert.equal(selectExactTmuxWindowPane(panes, 'ff-1', 'rev1-claude'), null);
  });
});
