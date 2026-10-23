import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  buildNodeSupportActivationCommand,
  persistedNodeSupportHashes,
  referencedNodeSupportHashes,
} from './activation.js';

const exec = promisify(execFile);
const hash = (letter: string) => letter.repeat(64);

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
