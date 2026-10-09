import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';

import type { SlotVars } from '../../core/index.js';

// runPrepareCommand is driven through a faked slot exec layer: no tmux server,
// shell or process is touched. Only the exec layer and session lookup are faked.
const commands: string[] = [];
/** Runs when the wrapper launch (respawn-pane) is issued. */
let onLaunch: (() => void) | null;

const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    isLocal: () => false,
    execOnSlot: async (_vars: unknown, cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('respawn-pane')) onLaunch?.();
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => 'mm-1' },
});

const { runPrepareCommand } = await import('./prepare-command.js');

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
