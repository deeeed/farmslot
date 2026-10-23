import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  buildNodeSupportActivationCommand,
  persistedNodeSupportHashes,
  referencedNodeSupportHashes,
  wrapNodeSupportReadCommand,
} from './activation.js';

const exec = promisify(execFile);
const hash = (letter: string) => letter.repeat(64);

async function present(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

test('one-shot activation retains persisted non-archived run references without a loaded store', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'support-run-refs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, 'done.json'),
    JSON.stringify({
      id: 'done',
      status: 'done',
      steps: [{ outputs: { nodeSupportHash: hash('a') } }],
    }),
  );
  await mkdir(path.join(directory, 'archive'));
  await writeFile(
    path.join(directory, 'archive', 'old.json'),
    JSON.stringify({ bundle: hash('b') }),
  );
  await writeFile(
    path.join(directory, 'archived.json'),
    JSON.stringify({ archivedAt: 'now', bundle: hash('c') }),
  );
  assert.deepEqual(await persistedNodeSupportHashes(directory), [hash('a')]);
  // A listed entry whose target vanished produces the same read-time ENOENT as archiving.
  await symlink(path.join(directory, 'removed-run'), path.join(directory, 'vanished.json'));
  assert.deepEqual(await persistedNodeSupportHashes(directory), [hash('a')]);
  await writeFile(path.join(directory, 'broken.json'), '{');
  await assert.rejects(persistedNodeSupportHashes(directory));
});

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'support-activation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'farmslot-node', 'support');
  await mkdir(root, { recursive: true });
  const bundle = async (id: string) => {
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, id, 'manifest.json'), JSON.stringify({ hash: id }));
  };
  const pointer = async (name: string, id: string) => {
    const file = path.join(home, name, 'node-support-hash');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${id}\n`);
    return file;
  };
  return { home, root, bundle, pointer };
}

test('activation retains all slot selections and non-archived run references, and prunes the rest', async (t) => {
  const f = await fixture(t);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map(hash);
  for (const id of ids) await f.bundle(id);
  const mine = await f.pointer('mine', hash('a'));
  const disabled = await f.pointer('disabled-slot', hash('b'));
  const runs = [
    makeRun({
      status: 'done',
      steps: [
        { name: 'prepare', status: 'done', outputs: { nodeSupportDir: `${f.root}/${hash('c')}` } },
      ],
    }),
    makeRun({
      status: 'cancelled',
      steps: [
        {
          name: 'dispatch',
          status: 'done',
          inputs: { command: `bash '${f.root}/${hash('d')}/scripts/worker.sh'` },
        },
      ],
    }),
    {
      ...makeRun({
        steps: [
          {
            name: 'prepare',
            status: 'done',
            outputs: { nodeSupportDir: `${f.root}/${hash('e')}` },
          },
        ],
      }),
      archivedAt: '2026-10-23T00:00:00Z',
    },
  ];
  const command = buildNodeSupportActivationCommand({
    supportDir: path.join(f.root, hash('f')),
    supportHash: hash('f'),
    selectionPath: mine,
    references: { selectionPaths: [mine, disabled], runHashes: referencedNodeSupportHashes(runs) },
    verifyCommand: 'true',
  });
  await exec('/bin/sh', ['-c', command]);
  assert.deepEqual(
    (await readdir(f.root)).filter((id) => /^[a-f0-9]{64}$/.test(id)).sort(),
    ['b', 'c', 'd', 'f'].map(hash),
  );
  assert.equal((await readFile(disabled, 'utf8')).trim(), hash('b'));
  assert.equal((await readFile(mine, 'utf8')).trim(), hash('f'));
});

test('an unreadable selection or failed verification prevents activation and pruning', async (t) => {
  const f = await fixture(t);
  await f.bundle(hash('a'));
  await f.bundle(hash('b'));
  const mine = await f.pointer('mine', hash('a'));
  const unknown = await f.pointer('other-slot', 'not-a-bundle-hash');
  const params = {
    supportDir: path.join(f.root, hash('b')),
    supportHash: hash('b'),
    selectionPath: mine,
    references: { selectionPaths: [mine, unknown], runHashes: [] },
    verifyCommand: 'true',
  };
  await assert.rejects(
    exec('/bin/sh', ['-c', buildNodeSupportActivationCommand(params)]),
    /Invalid node support selection/,
  );
  await assert.rejects(
    exec('/bin/sh', [
      '-c',
      buildNodeSupportActivationCommand({ ...params, verifyCommand: 'false' }),
    ]),
  );
  assert.equal((await readFile(mine, 'utf8')).trim(), hash('a'));
  assert.ok((await readdir(f.root)).includes(hash('a')));
});

test('pruning ignores staging, active publishers and symlinks outside the bundle root', async (t) => {
  const f = await fixture(t);
  await f.bundle(hash('a'));
  await f.bundle(hash('b'));
  await mkdir(path.join(f.root, '.incoming'));
  await mkdir(path.join(f.root, '.locks', `${hash('b')}.lock`), { recursive: true });
  const outside = path.join(f.home, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'evidence');
  await symlink(outside, path.join(f.root, hash('c')));
  const mine = await f.pointer('mine', hash('a'));
  await exec('/bin/sh', [
    '-c',
    buildNodeSupportActivationCommand({
      supportDir: path.join(f.root, hash('a')),
      supportHash: hash('a'),
      selectionPath: mine,
      references: { selectionPaths: [mine], runHashes: [] },
      verifyCommand: 'true',
    }),
  ]);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'evidence');
  assert.ok((await readdir(f.root)).includes(hash('b')));
  assert.ok((await readdir(f.root)).includes('.incoming'));
});

test('concurrent activations serialize publication, selection and pruning', async (t) => {
  const f = await fixture(t);
  const one = await f.pointer('one', hash('a'));
  const two = await f.pointer('two', hash('b'));
  const activate = (id: string, selectionPath: string) => {
    const dir = path.join(f.root, id);
    const publishCommand = `mkdir -p '${dir}' && printf '%s' '{"hash":"${id}"}' > '${dir}/manifest.json'`;
    return exec('/bin/sh', [
      '-c',
      buildNodeSupportActivationCommand({
        supportDir: dir,
        supportHash: id,
        selectionPath,
        references: { selectionPaths: [one, two], runHashes: [] },
        publishCommand,
        verifyCommand: 'true',
      }),
    ]);
  };
  await Promise.all([activate(hash('c'), one), activate(hash('d'), two)]);
  assert.equal((await readFile(one, 'utf8')).trim(), hash('c'));
  assert.equal((await readFile(two, 'utf8')).trim(), hash('d'));
  assert.ok((await readdir(f.root)).includes(hash('c')));
  assert.ok((await readdir(f.root)).includes(hash('d')));
});

test('a cached read-only bundle survives another activation and preserves command failure status', async (t) => {
  const f = await fixture(t);
  await f.bundle(hash('a'));
  await f.bundle(hash('b'));
  await writeFile(path.join(f.root, hash('a'), 'payload'), 'retained\n');
  await exec('/bin/sh', [
    '-c',
    buildNodeSupportActivationCommand({
      supportDir: path.join(f.root, hash('a')),
      supportHash: hash('a'),
      readerTtlMs: 60_000,
      references: { selectionPaths: [], runHashes: [] },
      verifyCommand: 'true',
    }),
  ]);
  const pointer = await f.pointer('other-project', hash('b'));
  const cached = wrapNodeSupportReadCommand(
    `cat '${f.root}/${hash('a')}/payload'; exit 7`,
    path.join(f.root, hash('a')),
  );
  await assert.rejects(
    exec('/bin/sh', ['-c', cached]),
    (error) => error instanceof Error && 'code' in error && error.code === 7,
  );
  await exec('/bin/sh', [
    '-c',
    buildNodeSupportActivationCommand({
      supportDir: path.join(f.root, hash('b')),
      supportHash: hash('b'),
      selectionPath: pointer,
      references: { selectionPaths: [pointer], runHashes: [] },
      verifyCommand: 'true',
    }),
  ]);
  await assert.rejects(
    exec('/bin/sh', ['-c', cached]),
    (error) => error instanceof Error && 'code' in error && error.code === 7,
  );
  assert.equal(await readFile(path.join(f.root, hash('a'), 'payload'), 'utf8'), 'retained\n');
  // Observe the wrapper's signal before an outer shell can convert it to exit 137.
  await assert.rejects(
    exec('/bin/sh', [
      '-c',
      `exec ${wrapNodeSupportReadCommand('kill -KILL $$', path.join(f.root, hash('a')))}`,
    ]),
    (error) => error instanceof Error && 'signal' in error && error.signal === 'SIGKILL',
  );
});

test('an in-flight read stays protected after its cache reference expires', async (t) => {
  const f = await fixture(t);
  await f.bundle(hash('a'));
  await f.bundle(hash('b'));
  await mkdir(path.join(f.root, '.readers'));
  const lease = path.join(f.root, '.readers', `${hash('a')}.json`);
  await writeFile(lease, JSON.stringify({ expiresAt: Date.now() / 1000 + 60 }));
  const started = path.join(f.home, 'read-started');
  const finish = path.join(f.home, 'read-finish');
  const pointer = await f.pointer('other-project', hash('b'));
  const reader = exec('/bin/sh', [
    '-c',
    wrapNodeSupportReadCommand(
      `touch '${started}'; while ! test -f '${finish}'; do sleep 0.02; done`,
      path.join(f.root, hash('a')),
    ),
  ]);
  let activation: ReturnType<typeof exec> | undefined;
  try {
    const deadline = Date.now() + 2500;
    while (!(await present(started))) {
      assert.ok(Date.now() < deadline, 'the owned read did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await writeFile(lease, JSON.stringify({ expiresAt: 0 }));
    const exclusiveProbe =
      "import fcntl,sys\nf=open(sys.argv[1],'a')\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(42)\n";
    await assert.rejects(
      exec('python3', ['-c', exclusiveProbe, path.join(f.root, '.activation.lock')]),
      (error) => error instanceof Error && 'code' in error && error.code === 42,
    );
    activation = exec('/bin/sh', [
      '-c',
      buildNodeSupportActivationCommand({
        supportDir: path.join(f.root, hash('b')),
        supportHash: hash('b'),
        selectionPath: pointer,
        references: { selectionPaths: [pointer], runHashes: [] },
        verifyCommand: 'true',
      }),
    ]);
    assert.ok(await present(path.join(f.root, hash('a'))));
  } finally {
    await writeFile(finish, 'finish');
    await reader;
    if (activation) await activation;
  }
  assert.equal(await present(path.join(f.root, hash('a'))), false);
});

test('a read-only command preserves the executing shell and pipefail support', async (t) => {
  const f = await fixture(t);
  await f.bundle(hash('a'));
  const command = wrapNodeSupportReadCommand(
    'set -o pipefail; printf "%s" "$0"',
    path.join(f.root, hash('a')),
  );
  const result = await exec('/bin/bash', ['-c', command]);
  assert.equal(result.stdout, '/bin/bash');
});

test('a read-only zsh command preserves the node no-startup-file policy', async (t) => {
  if (!(await present('/bin/zsh'))) return t.skip('zsh is unavailable on this platform');
  const f = await fixture(t);
  await f.bundle(hash('a'));
  const sentinel = path.join(f.home, 'startup-read');
  await writeFile(
    path.join(f.home, '.zshenv'),
    'touch "$ZDOTDIR/startup-read"; printf unexpected-startup',
  );
  const command = wrapNodeSupportReadCommand('printf expected', path.join(f.root, hash('a')));
  const result = await exec('/bin/zsh', ['-f', '-c', command], {
    env: { ...process.env, ZDOTDIR: f.home },
  });
  assert.equal(result.stdout, 'expected');
  assert.equal(await present(sentinel), false);
});
