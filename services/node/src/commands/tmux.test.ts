import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { PANE_FIELD_SEPARATOR, PANE_FORMAT, parseTmuxPaneList, readPaneSignals } from './tmux.js';

const execFileAsync = promisify(execFile);
const sep = PANE_FIELD_SEPARATOR;

test('parseTmuxPaneList parses all pane identity and metadata fields', () => {
  const stdout = [
    [
      'omx-session',
      '2',
      'worker',
      '1',
      '%12',
      '1',
      '120',
      '42',
      'codex',
      '/Users/example/dev/farmslot',
      'codex',
      '4242',
    ].join(sep),
  ].join('\n');

  assert.deepEqual(parseTmuxPaneList(stdout), [
    {
      session: 'omx-session',
      window: '2',
      windowName: 'worker',
      pane: '1',
      paneId: '%12',
      target: '%12',
      active: true,
      width: 120,
      height: 42,
      title: 'codex',
      cwd: '/Users/example/dev/farmslot',
      command: 'codex',
      pid: 4242,
    },
  ]);
});

test('parseTmuxPaneList falls back to session window pane target when pane id is absent', () => {
  const stdout = ['shell', '0', 'zsh', '3', '', '0', '', '', '', '', 'zsh', ''].join(sep);

  assert.deepEqual(parseTmuxPaneList(stdout), [
    {
      session: 'shell',
      window: '0',
      windowName: 'zsh',
      pane: '3',
      target: 'shell:0.3',
      active: false,
      command: 'zsh',
    },
  ]);
});

test('parseTmuxPaneList parses real tmux list-panes output with the production format', async (t) => {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: 2000 });
  } catch (error) {
    // This test is a live contract check for machines with tmux installed. CI or
    // package-only environments without tmux still run the pure parser tests.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('tmux is not installed');
      return;
    }
    throw error;
  }

  const session = `farmslot_parser_smoke_${process.pid}_${Date.now()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'farmslot_parser_cwd_with_underscores_'));
  const resolvedCwd = await realpath(cwd);

  await execFileAsync('tmux', [
    'new-session',
    '-d',
    '-s',
    session,
    '-c',
    cwd,
    'bash',
    '--noprofile',
    '--norc',
  ]);
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['list-panes', '-t', session, '-F', PANE_FORMAT],
      { timeout: 2000 },
    );
    assert.match(stdout, /<<<FARMSLOT_TMUX_FIELD>>>/);
    const panes = parseTmuxPaneList(stdout);
    assert.equal(panes.length, 1);
    assert.equal(panes[0].session, session);
    assert.match(panes[0].window, /^\d+$/);
    assert.match(panes[0].pane, /^\d+$/);
    assert.match(panes[0].paneId ?? '', /^%\d+$/);
    assert.equal(panes[0].cwd, resolvedCwd);
    assert.equal(panes[0].command, 'bash');
    assert.equal(panes[0].target, panes[0].paneId);
  } finally {
    await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 2000 });
  }
});

test('parseTmuxPaneList surfaces malformed rows', () => {
  assert.throws(
    () => parseTmuxPaneList('session_1__1_%2_1_108_66_title_/tmp_zsh_88379'),
    /malformed row: expected 12 fields, got 1/,
  );
});

test('readPaneSignals reads hook statusline and task signals from pane cwd', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-tmux-signals-'));
  await mkdir(path.join(dir, '.observability'));
  await writeFile(
    path.join(dir, '.observability', 'hooks.jsonl'),
    JSON.stringify({ hook_event_name: 'Stop', observed_at: 1779411227 }) + '\n',
  );
  await writeFile(
    path.join(dir, '.observability', 'statusline.json'),
    JSON.stringify({ busy: false, model: 'sonnet', ctxPct: 42, mtime: 1779411228 }),
  );
  await writeFile(
    path.join(dir, 'SIGNAL.json'),
    JSON.stringify({ phase: 'validate', status: 'running', timestamp: 1779411229000 }),
  );

  assert.deepEqual(await readPaneSignals(dir), {
    hook: { event: 'Stop', label: 'hook Stop', observedAt: 1779411227000 },
    statusline: {
      label: 'idle · sonnet · ctx 42%',
      observedAt: 1779411228000,
      busy: false,
      model: 'sonnet',
      ctxPct: 42,
    },
    taskFile: {
      label: 'validate · running',
      observedAt: 1779411229000,
      status: 'running',
      phase: 'validate',
    },
  });
});
