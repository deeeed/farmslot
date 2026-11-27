import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { SlotVars } from '../../core/index.js';

// runPrepareCommand on a remote slot, through a faked exec layer. The command's last output
// reaches the slot-host log as it exits, so only the final drain after the sentinel reads it.
const FINAL = 'error: the install failed for this reason\n';
let exited = false;
const fakeExec = async (cmd: string) => {
  if (cmd.startsWith('wc -c < '))
    return { stdout: `${exited ? FINAL.length : 0}\n`, stderr: '', exitCode: 0 };
  if (cmd.startsWith('tail -c +')) return { stdout: FINAL, stderr: '', exitCode: 0 };
  const sentinel = /test -f '[^']*-([0-9a-f]+)\.exit' && cat /.exec(cmd);
  if (sentinel) {
    exited = true;
    return { stdout: `1 ${sentinel[1]}\n`, stderr: '', exitCode: 0 };
  }
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
  namedExports: { ...realFiles, slotWriteFiles: async () => {} },
});
const realRemoteCommand = await import('../../node-support/remote-command.js');
mock.module('../../node-support/remote-command.js', {
  namedExports: {
    ...realRemoteCommand,
    resolveRemoteFarmCommand: async (_vars: unknown, command: string) => command,
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => 'mm-1' },
});
// A write that lands late: the command's final output takes 2 s (of mocked time) to reach the
// gateway log, while the footer prepare appends afterwards lands at once.
let failAppends = false;
const realFs = await import('node:fs/promises');
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    appendFile: async (...args: Parameters<typeof realFs.appendFile>) => {
      if (failAppends) throw new Error('ENOSPC: no space left on device');
      if (String(args[1]).includes(FINAL))
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      return realFs.appendFile(...args);
    },
  },
});

const { runPrepareCommand } = await import('./prepare-command.js');

test('a remote prepare returns only once its log holds the final output', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-prepare-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'deps.log');
  const vars = {
    slotId: 'mini-mm-3',
    host: 'mini',
    machine: 'mini',
    remoteRepo: '/slot',
    session: 'mm-1',
  } as SlotVars;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let result: Awaited<ReturnType<typeof runPrepareCommand>> | undefined;
  const running = runPrepareCommand(vars, log, 'yarn install', {
    windowLabel: 'run12345',
    phase: 'deps',
    tailPollIntervalMs: 10,
  }).then((value) => {
    result = value;
  });
  while (!result) {
    t.mock.timers.tick(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await running;

  assert.equal(result.exitCode, 1);
  // The run's error names this log, and the run keeps a copy of it straight away: the final
  // output is there, before the footer.
  const content = await readFile(log, 'utf8');
  assert.ok(content.includes(FINAL), content);
  assert.ok(content.indexOf(FINAL) < content.indexOf('[tmux] cmd exit=1'), content);
});

test('a gateway log that cannot be written does not stop the live output', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-prepare-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  failAppends = true;
  exited = false;
  t.after(() => {
    failAppends = false;
  });
  const seen: string[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const running = runPrepareCommand(
    {
      slotId: 'mini-mm-3',
      host: 'mini',
      machine: 'mini',
      remoteRepo: '/slot',
      session: 'mm-1',
    } as SlotVars,
    path.join(dir, 'deps.log'),
    'yarn install',
    {
      windowLabel: 'run12346',
      phase: 'deps',
      tailPollIntervalMs: 10,
      onOutput: (_stream, data) => seen.push(data),
    },
  )
    .catch(() => undefined)
    .finally(() => {
      done = true;
    });
  while (!done) {
    t.mock.timers.tick(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await running;
  assert.ok(seen.join('').includes(FINAL));
});
