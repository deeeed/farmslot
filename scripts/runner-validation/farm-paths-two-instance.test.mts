// Opt-in: executes real prepare shells. Run explicitly from the quality workflow.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import type { Run } from '@farmslot/protocol';
import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { materializeRunBundle, readRetainedRunBundle } from '@farmslot/run-bundle';
import type { SlotVars } from '../../services/gateway/src/core/config.js';

// Only replace tmux transport. The production prepare staging, shell wrapper,
// sentinel polling, local file transport and retained-bundle store all execute.
const tmux = await import('../../services/gateway/src/core/tmux.js');
mock.module('../../services/gateway/src/core/tmux.js', {
  namedExports: {
    ...tmux,
    resolveTmuxSession: async (slot: string) => slot,
    tmuxShellSnippet: (snippet: string) => {
      if (snippet.startsWith('respawn-pane ')) {
        const command = / bash ('[^']+')$/.exec(snippet);
        assert.ok(command, snippet);
        return `bash ${command[1]}`;
      }
      if (snippet.startsWith('display-message ')) return "printf '1\\n'";
      return 'true';
    },
  },
});
const { runPrepareCommand } =
  await import('../../services/gateway/src/methods/slot/prepare-command.js');
const { runBundleStore } =
  await import('../../services/gateway/src/run-completion/retained-artifacts.js');
const { resourceRevisions } = await import('../../services/gateway/src/resources/revisions.js');

function contains(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}
async function tree(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map((file) => path.join(root, file)).sort();
}

test('two homes prepare and retain proof under their own home/data roots, including A after B', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'two-farm-instances-')));
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    return rm(root, { recursive: true, force: true });
  });
  t.after(() => resourceRevisions.dispose());
  const prior = process.env;
  process.env = { ...prior };
  t.after(() => {
    process.env = prior;
  });
  for (const key of Object.keys(process.env))
    if (key.startsWith('FARMSLOT_')) delete process.env[key];
  const instances = await Promise.all(
    ['a', 'b'].map(async (name, index) => {
      const home = path.join(root, name);
      const dataRoot = path.join(root, 'volume', name);
      await mkdir(path.join(home, 'config'), { recursive: true });
      await writeFile(
        path.join(home, 'config/instance.json'),
        JSON.stringify({ layout: 2, name, dataRoot, ports: { gateway: 62401 + index } }),
      );
      const paths = resolveFarmPaths({ home, role: 'gateway', env: {} });
      for (const directory of [paths.pool, paths.projects, paths.code.node, dataRoot])
        await mkdir(directory, { recursive: true });
      return paths;
    }),
  );
  let selected = instances[0];
  const writes: { instance: string; file: string }[] = [];
  // Trap writes at the Node fs boundary, even temporary files later removed.
  // Paths outside the current instance fail before touching a shared machine path.
  const check = (file: unknown) => {
    if (typeof file !== 'string') return;
    const absolute = path.resolve(file);
    assert.ok(
      contains(selected.home, absolute) || contains(selected.data.root, absolute),
      `${selected.instance} attempted write outside its roots: ${absolute}`,
    );
    assert.ok(
      !instances.some(
        (other) =>
          other !== selected &&
          (contains(other.home, absolute) || contains(other.data.root, absolute)),
      ),
    );
    writes.push({ instance: selected.instance, file: absolute });
  };
  for (const name of [
    'mkdir',
    'writeFile',
    'appendFile',
    'open',
    'chmod',
    'rm',
    'rename',
    'copyFile',
    'cp',
  ] as const) {
    const original = fs[name];
    mock.method(fs, name, (...args: unknown[]) => {
      // rename source and destination both belong to the same selected instance.
      check(args[0]);
      if (name === 'rename' || name === 'copyFile' || name === 'cp') check(args[1]);
      return Reflect.apply(original, fs, args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const snapshots = new Map<string, string[]>();
  for (const paths of [instances[0], instances[1], instances[0]]) {
    selected = paths;
    process.env.FARMSLOT_HOME = paths.home;
    process.env.GATEWAY_PORT = paths.instance === 'a' ? '62401' : '62402';
    const taskDir = path.join(paths.projects, 'fixture/tasks/proof');
    await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    const task = '# Instance proof\n';
    const proof = `${paths.instance} retained proof`;
    await writeFile(path.join(taskDir, 'TASK.md'), task);
    const vars: SlotVars = {
      slotId: `slot-${paths.instance}`,
      machine: 'localhost',
      host: 'localhost',
      sshUser: 'test',
      osType: process.platform === 'darwin' ? 'darwin' : 'linux',
      platform: 'cli',
      claudePath: '',
      codexPath: '',
      opencodePath: '',
      cursorPath: '',
      grokPath: '',
      dispatchCmd: '',
      recycleCmd: '',
      repo: taskDir,
      remoteRepo: taskDir,
      session: `slot-${paths.instance}`,
      slotMode: 'dispatch',
      slotEnabled: true,
      sshTarget: 'localhost',
      projectName: 'fixture',
      resourceVars: {},
      machineEnv: {},
    };
    const result = await runPrepareCommand(
      vars,
      path.join(paths.state.logs, 'prepare.log'),
      `printf '%s' '${proof}' > artifacts/proof.txt`,
      {
        phase: 'deps',
        windowLabel: 'isolated',
        preserveOtherPrepareWindows: true,
        tailPollIntervalMs: 10,
      },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await readFile(path.join(taskDir, 'artifacts/proof.txt'), 'utf8'), proof);
    const run: Run = {
      id: `run-${paths.instance}`,
      familyId: `run-${paths.instance}`,
      lane: 'production',
      flowType: 'qa',
      mode: 'validation',
      status: 'done',
      project: 'fixture',
      ticketOrPr: 'proof',
      slotId: vars.slotId,
      branch: null,
      taskFile: path.join(taskDir, 'TASK.md'),
      steps: [],
      decisions: [],
      metrics: { nudgeCount: 0, model: 'scripted', runner: 'scripted' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const store = await runBundleStore(true);
    assert.equal(store.root, paths.data.runBundles);
    assert.equal(store.runsDir, paths.state.runs);
    const captured = await materializeRunBundle({
      store,
      farmslotRoot: paths.code.node,
      run,
      taskDir,
      artifacts: [
        { path: 'TASK.md', purpose: 'task-input' },
        {
          path: 'artifacts/proof.txt',
          purpose: 'report',
          sizeBytes: Buffer.byteLength(proof),
          sha256: createHash('sha256').update(proof).digest('hex'),
        },
      ],
      captureKey: 'proof',
      manifestDigest: 'proof',
      commit: async (ref) => {
        run.artifactBundle = ref;
        await writeFile(path.join(paths.state.runs, `${run.id}.json`), JSON.stringify(run));
      },
    });
    const retained = await readRetainedRunBundle(store, captured.ref, run.id);
    assert.equal(
      await readFile((await retained.resolveEntry('artifacts/proof.txt')).path, 'utf8'),
      proof,
    );
    const log = await readFile(path.join(paths.state.logs, 'prepare.log'), 'utf8');
    assert.ok(log.includes(paths.state.tmp));
    assert.ok(!log.includes('/tmp/farmslot-prepare'));
    for (const other of instances.filter((entry) => entry !== paths))
      if (snapshots.has(other.home))
        assert.deepEqual(await tree(other.home), snapshots.get(other.home));
    snapshots.set(paths.home, await tree(paths.home));
  }
  for (const paths of instances) {
    assert.ok(
      writes.some(
        (entry) => entry.instance === paths.instance && contains(paths.state.tmp, entry.file),
      ),
      'prepare staging was audited',
    );
    assert.ok(
      writes.some(
        (entry) => entry.instance === paths.instance && contains(paths.data.runBundles, entry.file),
      ),
      'bundle capture was audited',
    );
  }
});
