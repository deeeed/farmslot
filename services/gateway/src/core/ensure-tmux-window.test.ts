import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { SlotVars } from './config.js';

// ensureTmuxWindow is checked through the commands it issues to a mocked exec
// layer, backed by an in-memory model of the slot's tmux server. No test here
// starts, attaches to or kills a real tmux server.
const vars = { slotId: 'macpro-mm-1', remoteRepo: '/tmp/repo' } as SlotVars;
let sessions: Map<string, string[]>;
let issued: string[];
let hasSessionExit: number | null;
let createFails: boolean;
// Another caller creates the session (with its own window) just before ours.
let racedBy: string | null;

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const tmuxArgs = (cmd: string) =>
  cmd
    .split('\n')
    .at(-1)!
    .replace(/^"\$TMUX_BIN" /, '');

mock.module('./exec.js', {
  namedExports: {
    EXEC_TIMEOUT_EXIT_CODE: 124,
    isLocal: () => true,
    execLocal: async () => ok(),
    execArgvOnSlot: async () => ok(),
    execFileArgv: async () => ok(),
    execOnSlot: async (_vars: SlotVars, cmd: string) => {
      const args = tmuxArgs(cmd);
      issued.push(args);
      if (args.startsWith('list-panes -a')) {
        const lines = [...sessions].flatMap(([session, windows]) =>
          windows.map(
            (name, i) => `${session}\t${name}\t@${i + 1}\t${i}\t100\t%${i + 1}\t${4000 + i}`,
          ),
        );
        return ok(lines.join('\n'));
      }
      if (args.startsWith('has-session')) {
        if (hasSessionExit !== null)
          return { exitCode: hasSessionExit, stdout: '', stderr: 'timed out' };
        const name = /-t '=([^']+)'/.exec(args)?.[1];
        return name && sessions.has(name) ? ok() : { exitCode: 1, stdout: '', stderr: '' };
      }
      if (createFails)
        return { exitCode: 1, stdout: 'no server running on /tmp/tmux-501/default', stderr: '' };
      const created = /^new-session -d -s '([^']+)' -n '([^']+)'/.exec(args);
      if (created && racedBy) {
        sessions.set(created[1]!, [racedBy]);
        return { exitCode: 1, stdout: `duplicate session: ${created[1]}`, stderr: '' };
      }
      if (created) {
        sessions.set(created[1]!, [created[2]!]);
        return ok();
      }
      const added = /^new-window -t '=([^']+)' -n '([^']+)'/.exec(args);
      if (added && sessions.has(added[1]!)) {
        sessions.get(added[1]!)!.push(added[2]!);
        return ok();
      }
      return { exitCode: 1, stdout: `can't find session: ${added?.[1]}`, stderr: '' };
    },
  },
});

const { ensureTmuxWindow } = await import('./tmux.js');

beforeEach(() => {
  sessions = new Map();
  issued = [];
  hasSessionExit = null;
  createFails = false;
  racedBy = null;
});

test('a slot session lost to a reboot is created with the window, in the slot checkout', async () => {
  const ensured = await ensureTmuxWindow(vars, 'mm-1', 'self-review');

  assert.equal(ensured.disposition, 'created');
  assert.deepEqual(sessions.get('mm-1'), ['self-review']);
  assert.ok(
    issued.includes(`new-session -d -s 'mm-1' -n 'self-review' -c '/tmp/repo' 2>&1`),
    issued.join('\n'),
  );
  assert.ok(
    !issued.some((args) => args.startsWith('new-window')),
    'no window is added to a missing session',
  );
});

test('a live session gets the window added, with no new session', async () => {
  sessions.set('mm-1', ['dev']);

  const ensured = await ensureTmuxWindow(vars, 'mm-1', 'self-review');

  assert.equal(ensured.disposition, 'created');
  assert.deepEqual(sessions.get('mm-1'), ['dev', 'self-review']);
  assert.ok(issued.includes(`new-window -t '=mm-1' -n 'self-review' -d 2>&1`), issued.join('\n'));
  assert.ok(!issued.some((args) => args.startsWith('new-session')));
});

test('an existing window is reused without probing or creating', async () => {
  sessions.set('mm-1', ['self-review']);

  const ensured = await ensureTmuxWindow(vars, 'mm-1', 'self-review');

  assert.equal(ensured.disposition, 'existing');
  assert.deepEqual(
    issued.map((args) => args.split(' ')[0]),
    ['list-panes'],
  );
});

test('a session whose name only starts with the slot session does not count', async () => {
  sessions.set('mm-10', ['other']);

  await ensureTmuxWindow(vars, 'mm-1', 'self-review');

  assert.deepEqual(sessions.get('mm-10'), ['other']);
  assert.deepEqual(sessions.get('mm-1'), ['self-review']);
});

test('losing the create race to another caller still adds this window to its session', async () => {
  racedBy = 'dev';

  const ensured = await ensureTmuxWindow(vars, 'mm-1', 'self-review');

  assert.equal(ensured.disposition, 'created');
  assert.deepEqual(sessions.get('mm-1'), ['dev', 'self-review']);
  assert.ok(issued.includes(`new-window -t '=mm-1' -n 'self-review' -d 2>&1`), issued.join('\n'));
});

test('a has-session probe that times out fails instead of creating a duplicate session', async () => {
  hasSessionExit = 124;

  await assert.rejects(ensureTmuxWindow(vars, 'mm-1', 'self-review'), /timed out/);
  assert.ok(!issued.some((args) => args.startsWith('new-')));
});

test('a create that tmux refuses is reported with its output', async () => {
  createFails = true;

  await assert.rejects(
    ensureTmuxWindow(vars, 'mm-1', 'self-review'),
    /Failed to create tmux window mm-1:self-review: no server running/,
  );
});
