// @farmslot:serial — drives real tmux sessions and the shared repo `pool/` directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import '../core/private-pool.test-support.js';

import { poolDirectory } from '../core/config.js';
import { TMUX_FIELD_SEPARATOR } from '../core/tmux-fields.js';
import { createRun, deleteRun, getRun, updateRun, updateRunAgentContexts } from '../runs/store.js';

import { classifyPaneRows, paneReadDetail, restoreTmuxWorker } from './runtime-recovery.js';

// Real tmux only on the test runner's private server (scripts/quality/run-tsx-tests.mjs):
// no $TMUX, and plain `tmux` (from the code under test) resolving to that socket.
const tmuxSandbox =
  !process.env.TMUX &&
  process.env.TMUX_TMPDIR &&
  process.env.FARMSLOT_TMUX_SANDBOX ===
    `${process.env.TMUX_TMPDIR}/tmux-${process.getuid?.() ?? 0}/default`
    ? process.env.FARMSLOT_TMUX_SANDBOX
    : null;

const testPoolFile = path.join(poolDirectory(), `runtime-recovery-fixture-${process.pid}.json`);
const slotId = `runtime-recovery-${process.pid}`;
const sessionName = `fs-rt-recovery-${process.pid}`;

function tmuxAvailable(): boolean {
  if (!tmuxSandbox) return false;
  try {
    execFileSync('tmux', ['-S', tmuxSandbox!, '-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function killTmuxSession(): void {
  try {
    execFileSync('tmux', ['-S', tmuxSandbox!, 'kill-session', '-t', `=${sessionName}`], {
      stdio: 'ignore',
    });
  } catch {
    // Test cleanup only: the session may not exist if setup failed before tmux launch.
  }
}

function launchLiveCodexPane(): string {
  killTmuxSession();
  execFileSync(
    'tmux',
    [
      '-S',
      tmuxSandbox!,
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      'dev',
      '-c',
      process.cwd(),
      'bash -lc "exec -a codex sleep 600"',
    ],
    { stdio: 'ignore' },
  );
  waitForLiveCodexPane();
  return execFileSync(
    'tmux',
    ['-S', tmuxSandbox!, 'display-message', '-p', '-t', `=${sessionName}:dev`, '#{pane_id}'],
    { encoding: 'utf8' },
  ).trim();
}

function waitForLiveCodexPane(): void {
  const target = `=${sessionName}:dev`;
  const script = `
pane_pid=$(tmux list-panes -t ${JSON.stringify(target)} -F '#{pane_pid}' 2>/dev/null | head -1)
[ -n "$pane_pid" ] || exit 1
for _ in $(seq 1 20); do
  for pid in $(pgrep -f codex 2>/dev/null); do
    command=$(ps -o command= -p "$pid" 2>/dev/null || true)
    case "$command" in
      *'__farmslot_status'*) continue ;;
    esac
    cur=$pid
    while [ -n "$cur" ] && [ "$cur" != "$pane_pid" ] && [ "$cur" != "0" ] && [ "$cur" != "1" ]; do
      cur=$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' \\n\\r\\t')
    done
    if [ "$cur" = "$pane_pid" ]; then exit 0; fi
  done
  sleep 0.1
done
exit 1
`;
  execFileSync('bash', ['-lc', script], { stdio: 'ignore' });
}

async function cleanupRun(runId: string): Promise<void> {
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

before(() => {
  mkdirSync(poolDirectory(), { recursive: true });
  writeFileSync(
    testPoolFile,
    JSON.stringify(
      {
        machine: os.hostname(),
        project: 'farmslot-farm',
        platform: 'browser',
        os: 'darwin',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        slots: [
          {
            id: slotId,
            repo: process.cwd(),
            session: sessionName,
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
});

after(() => {
  killTmuxSession();
  rmSync(testPoolFile, { force: true });
});

const noDroppedRows = {
  unparsable: 0,
  fields: null,
  otherSession: 0,
  otherSessionNames: [],
  devserverLog: 0,
};

const PANE_FIELDS = ['fs-1', '0', 'dev', '0', '%0', '1890', 'sh', '/repo'];

test('pane rows are read by the field separator, not by a tab', () => {
  const kept = classifyPaneRows([PANE_FIELDS.join(TMUX_FIELD_SEPARATOR)], 'fs-1');
  assert.equal(kept.panes.length, 1);
  assert.deepEqual(kept.dropped.unparsable, 0);
  assert.equal(kept.panes[0]?.paneId, '%0');
  assert.equal(kept.panes[0]?.cwd, '/repo');

  // tmux 3.4 escapes control characters in -F output, so the row it returns for a
  // tab-separated format arrives as one field. Reading that row loosely would bind
  // a run to the wrong pane, so it is rejected and counted.
  const tabbed = classifyPaneRows([PANE_FIELDS.join('\t')], 'fs-1');
  assert.deepEqual(tabbed.panes, []);
  assert.equal(tabbed.dropped.unparsable, 1);
  assert.equal(tabbed.dropped.fields, 1);
});

test('pane rows of another session and the devserver log are counted apart', () => {
  const rows = [
    ['other', '0', 'dev', '0', '%1', '1', 'sh', '/repo'].join(TMUX_FIELD_SEPARATOR),
    ['fs-1', '0', 'devserver-log', '0', '%2', '2', 'sh', '/repo'].join(TMUX_FIELD_SEPARATOR),
    PANE_FIELDS.join(TMUX_FIELD_SEPARATOR),
  ];
  const read = classifyPaneRows(rows, 'fs-1');
  assert.equal(read.panes.length, 1);
  assert.equal(read.panes[0]?.paneId, '%0');
  assert.equal(read.dropped.otherSession, 1);
  assert.deepEqual(read.dropped.otherSessionNames, ['other']);
  assert.equal(read.dropped.devserverLog, 1);
  assert.equal(read.dropped.unparsable, 0);
});

test('a separator inside the last field keeps that value whole', () => {
  const cwd = `/repo/odd${TMUX_FIELD_SEPARATOR}name`;
  const read = classifyPaneRows(
    [[...PANE_FIELDS.slice(0, 7), cwd].join(TMUX_FIELD_SEPARATOR)],
    'fs-1',
  );
  assert.equal(read.panes.length, 1);
  assert.equal(read.panes[0]?.cwd, cwd);
});

test('pane-read detail reports the exit code, the rows printed and tmux stderr', () => {
  // A failed read that still delivered rows must say so: the count is what tmux
  // printed before parsing and the filters, not what survived them.
  assert.equal(
    paneReadDetail({
      exitCode: 1,
      stderr: "can't find window: dev",
      rows: 0,
      dropped: noDroppedRows,
      panes: [],
    }),
    "tmux exit 1, rows 0, can't find window: dev",
  );
  assert.equal(
    paneReadDetail({ exitCode: 124, stderr: '', rows: 2, dropped: noDroppedRows, panes: [] }),
    'tmux exit 124, rows 2',
  );
  assert.equal(
    paneReadDetail({ exitCode: 0, stderr: '', rows: 1, dropped: noDroppedRows, panes: [] }),
    'tmux exit 0, rows 1',
  );
});

test('pane-read detail names what dropped the rows a successful read printed', () => {
  // The Ubuntu sweep reported "rows 1" with no pane and no stderr; each reason
  // below produces that same shape, so the detail has to separate them.
  assert.equal(
    paneReadDetail({
      exitCode: 0,
      stderr: '',
      rows: 1,
      dropped: { ...noDroppedRows, unparsable: 1, fields: 1 },
      panes: [],
    }),
    'tmux exit 0, rows 1, unparsable 1 (fields 1)',
  );
  assert.equal(
    paneReadDetail({
      exitCode: 0,
      stderr: '',
      rows: 2,
      dropped: { ...noDroppedRows, otherSession: 2, otherSessionNames: ['mm-1', 'archive-7'] },
      panes: [],
    }),
    'tmux exit 0, rows 2, other session 2 ("mm-1" "archive-7")',
  );
  assert.equal(
    paneReadDetail({
      exitCode: 0,
      stderr: '',
      rows: 1,
      dropped: { ...noDroppedRows, devserverLog: 1 },
      panes: [],
    }),
    'tmux exit 0, rows 1, devserver-log 1',
  );
});

test('restore-window preserves working status for an already-live runner', async (t) => {
  if (!tmuxAvailable()) {
    t.skip('tmux unavailable');
    return;
  }
  const paneId = launchLiveCodexPane();
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `TEST-RESTORE-WINDOW-${process.pid}`,
    runner: 'codex',
    slotId,
  });
  t.after(() => cleanupRun(run.id));

  const result = await restoreTmuxWorker({
    slotId,
    runId: run.id,
    mode: 'restore-window',
  });

  assert.equal(result.restored, true);
  const context = getRun(run.id)?.agentContexts?.find((ctx) => ctx.id === 'dev');
  assert.equal(context?.status, 'working');
  assert.equal(context?.target?.session, sessionName);
  assert.equal(context?.target?.paneId, paneId);
  assert.equal(context?.target?.window, 'dev');
  assert.equal(context?.completedAt, undefined);
});

test('reload-session persists live target when the runner is already alive', async (t) => {
  if (!tmuxAvailable()) {
    t.skip('tmux unavailable');
    return;
  }
  const paneId = launchLiveCodexPane();
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `TEST-RELOAD-LIVE-${process.pid}`,
    runner: 'codex',
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRunAgentContexts(run.id, (_run, contexts) =>
    contexts.map((ctx) =>
      ctx.id === 'dev'
        ? {
            ...ctx,
            status: 'blocked',
            target: null,
            completedAt: '2026-07-10T00:00:00.000Z',
          }
        : ctx,
    ),
  );

  const result = await restoreTmuxWorker({
    slotId,
    runId: run.id,
    mode: 'reload-session',
  });

  assert.equal(result.restored, false);
  assert.equal(result.contexts[0]?.status, 'live');
  const context = getRun(run.id)?.agentContexts?.find((ctx) => ctx.id === 'dev');
  assert.equal(context?.status, 'working');
  assert.equal(context?.target?.session, sessionName);
  assert.equal(context?.target?.paneId, paneId);
  assert.equal(context?.target?.window, 'dev');
  assert.equal(context?.completedAt, undefined);
});
