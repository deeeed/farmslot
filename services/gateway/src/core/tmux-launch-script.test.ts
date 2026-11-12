import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parse } from 'shell-quote';

import '../runtime/mock-pty.test-support.js';

import { buildRoleLaunchCommandWithDiagnosticHold } from '../methods/dispatch/execute.js';
import { runLaunchPreludeAndSend } from '../methods/dispatch/launch-clear.js';
import { makeVars } from '../runners/test-fixtures.js';

import { withSlotCommandExecutor } from './exec-scope.js';
import {
  buildTmuxRespawnLaunchCommand,
  respawnTmuxPaneWithCommand,
  respawnTmuxWindowWithCommand,
  shellQuote,
} from './tmux.js';
import { writeTmuxLaunchScript } from './tmux-launch-script.js';
import { syntheticPiLaunch } from './tmux-launch-script.test-support.js';

const commands: string[] = [];
const capture = async (_vars: unknown, command: string) => {
  commands.push(command);
  return { exitCode: 0, stdout: '', stderr: '' };
};

test('real pi launch exceeds the old tmux limit; script respawns stay bounded for 64 KiB', async (t) =>
  withSlotCommandExecutor(capture, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tmux-launch-script-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const vars = makeVars({ machine: 'local', remoteRepo: path.join(root, 'repo') });
    const launch = syntheticPiLaunch(vars);
    const oldCommand = buildRoleLaunchCommandWithDiagnosticHold(launch, vars.remoteRepo);
    const oldArgument = shellQuote(oldCommand);
    assert.ok(Buffer.byteLength(oldCommand) > 16_384);
    t.diagnostic(
      `pi launch bytes=${Buffer.byteLength(launch)}, old tmux argv bytes=${Buffer.byteLength(oldCommand)}, old quoted argument bytes=${Buffer.byteLength(oldArgument)}`,
    );
    assert.ok(Buffer.byteLength(oldArgument) > 16_384);
    assert.match(launch, /node -e/);
    assert.match(launch, /installed bundle identity differs/);

    await respawnTmuxWindowWithCommand(vars, 'fixture:dev', launch, {
      preserveWindowAfterExit: true,
    });
    const first = commands.at(-2)!;
    const args = parse(first.slice(first.indexOf('"$TMUX_BIN" '))).filter(
      (part): part is string => typeof part === 'string',
    );
    const entry = args.at(-1)!;
    assert.match(entry, /^bash '.*\.sh'$/);
    assert.ok(Buffer.byteLength(first) < 2_048);
    const scriptPath = parse(entry)[1];
    assert.equal(typeof scriptPath, 'string');
    assert.ok(typeof scriptPath === 'string');
    assert.equal((await stat(scriptPath)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(scriptPath, 'utf8'),
      `#!/bin/bash\n${buildTmuxRespawnLaunchCommand(launch, vars.remoteRepo, true)}\n`,
    );
    assert.ok(!scriptPath.startsWith(`${vars.remoteRepo}/`));
    assert.ok(!scriptPath.includes('synthetic-task'));

    const huge = `printf '%s' '${'x'.repeat(65_536)}'`;
    await respawnTmuxWindowWithCommand(vars, 'fixture:dev', huge, {
      preserveWindowAfterExit: true,
    });
    assert.equal(commands.at(-2), first, 'tmux command depends only on the slot and target');
    assert.equal(
      await readFile(scriptPath, 'utf8'),
      `#!/bin/bash\n${buildTmuxRespawnLaunchCommand(huge, vars.remoteRepo, true)}\n`,
    );
    t.diagnostic(
      `new quoted tmux argument bytes=${Buffer.byteLength(shellQuote(entry))}, full tmux invocation bytes=${Buffer.byteLength(first)}`,
    );
  }));

test('remote slot writes a private staged script before respawning; targets have distinct files', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const vars = makeVars({
    host: 'remote.invalid',
    machine: 'synthetic-remote',
    remoteRepo: '~/slots/worker repo',
  });
  const io = {
    ...vars,
    nodeRequest: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { ok: true };
    },
  };
  const command = "export SYNTHETIC_SECRET='fixture only'; printf '%s' \"$SYNTHETIC_SECRET\"";
  const entry = await writeTmuxLaunchScript(io, 'fixture:dev', command);
  assert.match(
    entry,
    /^bash "\$\{HOME\}\/slots\/\.farmslot-runtime\/worker repo\/\.agent\/\.launch\/[a-f0-9]{64}\.sh"$/,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['fs.mkdir', 'fs.writeChunk', 'fs.rename'],
  );
  const write = calls[1]!.params;
  assert.ok(write && typeof write === 'object' && 'relPath' in write);
  assert.ok(typeof write.relPath === 'string');
  assert.match(write.relPath, /\.sh\.tmp\./);
  assert.deepEqual(write, {
    root: '~',
    relPath: write.relPath,
    offset: 0,
    content: Buffer.from(`#!/bin/bash\n${command}\n`).toString('base64'),
    truncate: true,
    mode: 0o600,
  });
  const renamed = calls[2]!.params;
  assert.deepEqual(renamed, {
    root: path.posix.dirname(`~/${write.relPath}`),
    oldRelPath: path.posix.basename(write.relPath),
    newRelPath: path.posix.basename(write.relPath).split('.tmp.')[0],
  });
  assert.equal(await writeTmuxLaunchScript(io, 'fixture:dev', 'next launch'), entry);
  assert.notEqual(await writeTmuxLaunchScript(io, 'fixture:review', command), entry);
  assert.notEqual(await writeTmuxLaunchScript(io, '%12', command), entry);
});

test('exact pane respawns use the script helper without collapsing siblings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tmux-launch-pane-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vars = makeVars({ machine: 'local', remoteRepo: path.join(root, 'repo') });
  const issued: string[] = [];
  await withSlotCommandExecutor(
    async (_vars, command) => {
      issued.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    () => respawnTmuxPaneWithCommand(vars, '%12', 'exit 23'),
  );
  assert.equal(issued.length, 1);
  assert.match(issued[0]!, /respawn-pane -k -t '%12' -c/);
  assert.doesNotMatch(issued[0]!, /exit 23|kill-pane/);
  assert.match(issued[0]!, /\.sh/);
});

test('legacy send-keys launch types only the script path after the existing clears', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tmux-launch-send-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vars = makeVars({ machine: 'local', remoteRepo: path.join(root, 'repo') });
  const launch = `printf '%s' '${'x'.repeat(65_536)}'`;
  const entry = await writeTmuxLaunchScript(vars, 'fixture:0', launch);
  const issued: string[] = [];
  await runLaunchPreludeAndSend({
    runner: 'pi',
    target: 'fixture:0',
    session: 'fixture',
    launchCommand: entry,
    waits: { daWaitMs: 0, settleMs: 0, recreateSettleMs: 0 },
    exec: async (command) => {
      issued.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    assertOwnership: async () => assert.fail('no recovery needed'),
    reensureTarget: async () => assert.fail('no recovery needed'),
    sleep: async () => {},
  });
  assert.deepEqual(issued, [
    "send-keys -t 'fixture:0' C-c C-u",
    "send-keys -t 'fixture:0' C-c C-u",
    `send-keys -t 'fixture:0' -l ${shellQuote(entry)}`,
    "send-keys -t 'fixture:0' Enter",
  ]);
  assert.ok(issued.every((command) => Buffer.byteLength(command) < 2_048));
  const scriptPath = parse(entry)[1];
  assert.ok(typeof scriptPath === 'string');
  assert.equal(await readFile(scriptPath, 'utf8'), `#!/bin/bash\n${launch}\n`);
});

test('failed remote script publication never respawns a runner', async () => {
  const vars = {
    ...makeVars({ host: 'remote.invalid', machine: 'synthetic-remote', remoteRepo: '/slots/repo' }),
    nodeRequest: async (method: string) => {
      if (method === 'fs.rename') throw new Error('synthetic rename denied');
      return { ok: true };
    },
  };
  await withSlotCommandExecutor(
    async () => {
      assert.fail('must publish the script before mutating tmux');
    },
    async () => {
      await assert.rejects(
        respawnTmuxWindowWithCommand(vars, 'fixture:dev', 'exit 0'),
        /synthetic rename denied/,
      );
    },
  );
});

for (const configured of [false, true])
  test(`remote farm references resolve before publication, configured workspace=${configured}`, async (t) => {
    const { farmPathsForSlot } = await import('../fleet/farm-paths.js');
    const vars = makeVars({
      host: 'remote.invalid',
      machine: 'synthetic-remote',
      machineEnv: configured ? { FARMSLOT_WORKSPACE: '/configured/farm-node' } : {},
    });
    const root = configured ? '/configured/farm-node' : farmPathsForSlot(vars).code.node;
    const original = `bash '${root}/scripts/synthetic.sh'`;
    const resolved = "bash '/synthetic-support/scripts/synthetic.sh'";
    let resolutions = 0;
    t.mock.module('../node-support/remote-command.js', {
      namedExports: {
        resolveRemoteFarmCommand: async (receivedVars: unknown, command: string) => {
          assert.equal(receivedVars, io);
          assert.equal(command, original);
          resolutions += 1;
          return resolved;
        },
      },
    });
    let staged: unknown;
    const io = {
      ...vars,
      nodeRequest: async (method: string, params: unknown) => {
        if (method === 'fs.writeChunk') staged = params;
        return { ok: true };
      },
    };
    await writeTmuxLaunchScript(io, 'fixture:dev', original);
    assert.equal(resolutions, 1);
    assert.ok(
      staged &&
        typeof staged === 'object' &&
        'content' in staged &&
        typeof staged.content === 'string',
    );
    assert.equal(Buffer.from(staged.content, 'base64').toString(), `#!/bin/bash\n${resolved}\n`);
    await withSlotCommandExecutor(capture, () =>
      writeTmuxLaunchScript(io, 'fixture:dev', original),
    );
    assert.equal(resolutions, 1, 'owned executors keep their existing support selection contract');
  });

test('window and pane ownership fences run after remote publication and before respawn', async () => {
  for (const target of ['fixture:dev', '%12']) {
    const calls: string[] = [];
    const vars = {
      ...makeVars({
        host: 'remote.invalid',
        machine: 'synthetic-remote',
        remoteRepo: '/slots/repo',
      }),
      nodeRequest: async (method: string) => {
        calls.push(method);
        return { ok: true };
      },
    };
    await withSlotCommandExecutor(
      async (_vars, command) => {
        calls.push(command.includes('respawn-') ? 'respawn' : 'collapse');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async () => {
        const beforeRespawn = () => {
          assert.deepEqual(calls, ['fs.mkdir', 'fs.writeChunk', 'fs.rename']);
          calls.push('fence');
        };
        if (target.startsWith('%'))
          await respawnTmuxPaneWithCommand(vars, target, 'exit 0', { beforeRespawn });
        else await respawnTmuxWindowWithCommand(vars, target, 'exit 0', { beforeRespawn });
      },
    );
    assert.deepEqual(calls.slice(3, 5), ['fence', 'respawn']);
  }
});
