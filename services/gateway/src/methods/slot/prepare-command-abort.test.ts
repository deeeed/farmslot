import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';

import type { SlotVars } from '../../core/index.js';
import type { SlotLocality, SlotWriteFileEntry } from '../../core/slot-io.js';

// runPrepareCommand is driven through a faked slot exec layer: no tmux server,
// shell or process is touched. Execution, file transport and session lookup are faked.
const commands: string[] = [];
interface StagedFiles {
  ctx: SlotLocality;
  root: string;
  files: SlotWriteFileEntry[];
}
const staged: StagedFiles[] = [];
let writeFailure: Error | undefined;
/** Runs when the wrapper launch (respawn-pane) is issued. */
let onLaunch: (() => void) | null;
const fakeExec = async (cmd: string) => {
  commands.push(cmd);
  if (cmd.includes('respawn-pane')) onLaunch?.();
  return { stdout: '', stderr: '', exitCode: 0 };
};

const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    isLocal: () => false,
    execOnSlot: async (_vars: unknown, cmd: string) => fakeExec(cmd),
    execLocal: fakeExec,
  },
});
const realFiles = await import('../../core/slot-io.js');
mock.module('../../core/slot-io.js', {
  namedExports: {
    ...realFiles,
    slotWriteFiles: async (ctx: SlotLocality, root: string, files: SlotWriteFileEntry[]) => {
      if (writeFailure) throw writeFailure;
      staged.push({ ctx, root, files });
    },
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => 'mm-1' },
});

const {
  runPrepareCommand,
  buildPreparePreLaunchSweepCommand,
  buildPrepareKillWindowsByNameCommand,
} = await import('./prepare-command.js');

const vars = {
  slotId: 'macpro-mm-1',
  host: 'macpro',
  machine: 'macpro',
  remoteRepo: '/slot',
  session: 'mm-1',
} as SlotVars;
const prepareScope = { token: 'c'.repeat(32), identityPath: '/slot/.agent/preflight.identity' };
const reaps = () =>
  // Starts with the identity, unlike the staged wrapper that embeds its own reap.
  commands.filter((cmd) => cmd.startsWith(`identityfile='${prepareScope.identityPath}'`));

beforeEach(() => {
  commands.length = 0;
  staged.length = 0;
  writeFailure = undefined;
  onLaunch = null;
});

// One scratch dir for the gateway-side prepare logs, removed afterwards: the
// test runner fails files that leave entries in TMPDIR.
let logDir: string;
before(async () => {
  logDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-prepare-abort-'));
});
after(() => rmSync(logDir, { recursive: true, force: true }));

async function logPath(): Promise<string> {
  return path.join(logDir, `${randomUUID()}.log`);
}

test('a cancel during preflight setup never launches the wrapper', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runPrepareCommand(vars, await logPath(), 'true', {
    signal: controller.signal,
    windowLabel: 'run12345',
    phase: 'preflight',
    prepareScope,
  });

  assert.equal(result.exitCode, 130);
  assert.ok(!commands.some((cmd) => cmd.includes('respawn-pane')), 'no holder may start');
});

test('a cancel after launch reaps this prepare scope once the window is killed', async () => {
  const controller = new AbortController();
  onLaunch = () => controller.abort();

  const result = await runPrepareCommand(vars, await logPath(), 'true', {
    signal: controller.signal,
    windowLabel: 'run12345',
    phase: 'preflight',
    prepareScope,
    tailPollIntervalMs: 10,
  });

  assert.equal(result.exitCode, 130);
  assert.equal(reaps().length, 1, 'the nohup holder survives the window kill');
  assert.match(reaps()[0]!, new RegExp(`!= '${prepareScope.token}'`), 'only this prepare scope');
});

test('a signing probe preserves retained preflight panes and cleans only its own window', async () => {
  const controller = new AbortController();
  onLaunch = () => controller.abort();
  const result = await runPrepareCommand(vars, await logPath(), 'true', {
    signal: controller.signal,
    windowLabel: 'probe123',
    phase: 'signing',
    preserveOtherPrepareWindows: true,
    tailPollIntervalMs: 10,
  });
  assert.equal(result.exitCode, 130);
  assert.ok(
    !commands.includes(buildPreparePreLaunchSweepCommand('mm-1', 'probe123')),
    'a retained prior preflight pane must not be swept',
  );
  assert.ok(
    commands.includes(buildPrepareKillWindowsByNameCommand('mm-1', 'prepare-probe123-signing')),
    'same-phase cleanup stays scoped to this probe',
  );
  assert.ok(
    commands.some(
      (command) => command.includes('kill-window') && command.includes('prepare-probe123-signing'),
    ),
    'the probe still cleans up its own window',
  );
});

test('a large diff is transferred as a script file while every exec command stays bounded', async () => {
  const controller = new AbortController();
  onLaunch = () => controller.abort();
  const diff = 'diff --git a/large b/large\n+' + 'x'.repeat(1536 * 1024);
  const cmd = `cat <<'LARGE_DIFF'\n${diff}\nLARGE_DIFF`;
  const result = await runPrepareCommand(vars, await logPath(), cmd, {
    signal: controller.signal,
    windowLabel: 'large-diff',
    phase: 'deps',
    tailPollIntervalMs: 10,
  });
  assert.equal(result.exitCode, 130);
  assert.ok(
    Math.max(...commands.map((command) => Buffer.byteLength(command))) < 65536,
    'script payload must never cross the shell argv boundary',
  );
  const write = staged[0];
  assert.ok(write);
  assert.equal(write.ctx, vars);
  const script = write.files.find((file) => file.path.endsWith('.sh'));
  assert.ok(script);
  assert.equal(script.mode, 0o600);
  assert.ok(
    Buffer.from(script.content, 'base64').toString().includes(cmd),
    'large diff bytes retained',
  );
});

test('force-local staging writes on the orchestrator even when the slot is remote', async () => {
  const controller = new AbortController();
  onLaunch = () => controller.abort();
  const result = await runPrepareCommand(vars, await logPath(), 'true', {
    forceLocal: true,
    signal: controller.signal,
    windowLabel: 'local-stage',
    phase: 'deps',
    tailPollIntervalMs: 10,
  });
  assert.equal(result.exitCode, 130);
  assert.equal(staged[0]?.ctx.host, 'localhost');
  assert.notEqual(staged[0]?.ctx, vars);
});

test('a failed script transfer refuses before the wrapper launches', async () => {
  const controller = new AbortController();
  onLaunch = () => controller.abort();
  writeFailure = new Error('Fixture script transfer failed');
  await assert.rejects(
    runPrepareCommand(vars, await logPath(), 'true', {
      signal: controller.signal,
      windowLabel: 'failed-stage',
      phase: 'deps',
      tailPollIntervalMs: 10,
    }),
    /Fixture script transfer failed/,
  );
  assert.ok(!commands.some((command) => command.includes('respawn-pane')));
});
