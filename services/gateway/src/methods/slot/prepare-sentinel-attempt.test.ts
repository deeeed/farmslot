import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';

import type { SlotVars } from '../../core/index.js';

// runPrepareCommand is driven through a faked slot exec layer with an in-memory
// slot filesystem: no tmux server, shell or process is touched.
const files = new Map<string, string>();
const commands: string[] = [];

const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    isLocal: () => false,
    execOnSlot: async (_vars: unknown, cmd: string) => {
      commands.push(cmd);
      const sentinel = /^test -f '([^']+)' && cat/.exec(cmd);
      if (sentinel) {
        const content = files.get(sentinel[1]!);
        return content === undefined
          ? { stdout: '', stderr: '', exitCode: 1 }
          : { stdout: content, stderr: '', exitCode: 0 };
      }
      // This launch completes as soon as its wrapper is staged.
      const staged = /cat > '([^']+)-([0-9a-f]{12})\.sh' <</.exec(cmd);
      if (staged) files.set(`${staged[1]}-${staged[2]}.exit`, `0 ${staged[2]}\n`);
      if (cmd.includes("'#{pane_dead}'")) return { stdout: '1\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => 'mm-pixel6' },
});

const { buildPrepareStaleLaunchCleanupCommand, runPrepareCommand } =
  await import('./prepare-command.js');

const vars = {
  slotId: 'macwork-mm-pixel6',
  host: 'macwork',
  machine: 'macwork',
  remoteRepo: '/slot',
  session: 'mm-pixel6',
} as SlotVars;

let logDir: string;
before(async () => {
  logDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-prepare-attempt-'));
});
after(() => rmSync(logDir, { recursive: true, force: true }));

test("an earlier launch's late exit code never decides the current launch", async () => {
  // Orphans of earlier launches of this phase finally exited and their traps
  // recorded SIGHUP/SIGTERM: one written by a gateway that predates per-launch
  // sentinels, one by an earlier launch of this gateway.
  const base = '/tmp/farmslot-prepare/mm-pixel6-prepare-3e2f400a-deps';
  files.set(`${base}.exit`, '129\n');
  files.set(`${base}-0123456789ab.exit`, '143 0123456789ab\n');

  const result = await runPrepareCommand(vars, path.join(logDir, 'deps.log'), 'yarn setup', {
    windowLabel: '3e2f400a',
    phase: 'deps',
    tailPollIntervalMs: 10,
  });

  assert.equal(result.exitCode, 0);
  const polled = commands
    .map((cmd) => /^test -f '([^']+)' && cat/.exec(cmd)?.[1])
    .filter((value): value is string => Boolean(value));
  assert.ok(polled.length > 0);
  assert.ok(
    polled.every(
      (sentinel) =>
        /^\/tmp\/farmslot-prepare\/mm-pixel6-prepare-3e2f400a-deps-[0-9a-f]{12}\.exit$/.test(
          sentinel,
        ) && !sentinel.endsWith('-0123456789ab.exit'),
    ),
    `polled only this launch's sentinel: ${polled.join(', ')}`,
  );
  const stage = commands.find((cmd) => /cat > '[^']+' <</.test(cmd));
  assert.ok(stage, 'the wrapper is staged');
  assert.ok(
    stage.includes(
      buildPrepareStaleLaunchCleanupCommand(
        '/tmp/farmslot-prepare',
        'mm-pixel6-prepare-3e2f400a-deps',
      ),
    ),
    'staging removes earlier launches of this phase',
  );
});
