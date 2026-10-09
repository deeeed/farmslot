import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { collectSupportFiles, supportHash } from './files.js';

test('collectSupportFiles preserves binary bytes and executable mode', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-support-'));
  const scriptPath = path.join(dir, 'helper.sh');
  const binaryPath = path.join(dir, 'payload.bin');
  await writeFile(scriptPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  await writeFile(binaryPath, Buffer.from([0, 255, 1, 254]));

  const files = await collectSupportFiles(dir, 'scripts');
  const script = files.find((file) => file.relativePath === 'scripts/helper.sh');
  const binary = files.find((file) => file.relativePath === 'scripts/payload.bin');

  assert.equal(script?.mode, 0o755);
  assert.equal(
    binary?.sha256,
    createHash('sha256')
      .update(Buffer.from([0, 255, 1, 254]))
      .digest('hex'),
  );
  assert.equal(
    Buffer.from(script?.contentBase64 ?? '', 'base64').toString(),
    '#!/bin/sh\necho ok\n',
  );
  assert.deepEqual([...Buffer.from(binary?.contentBase64 ?? '', 'base64')], [0, 255, 1, 254]);
});

test('supportHash includes executable mode', () => {
  const base = {
    relativePath: 'scripts/helper.sh',
    contentBase64: Buffer.from('#!/bin/sh\n').toString('base64'),
    size: 10,
  };

  assert.notEqual(supportHash([{ ...base, mode: 0o644 }]), supportHash([{ ...base, mode: 0o755 }]));
});

async function tree(t: test.TestContext): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'farmslot-support-links-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'library');
  await mkdir(path.join(root, 'actions'), { recursive: true });
  return { base, root };
}

function contentOf(files: Awaited<ReturnType<typeof collectSupportFiles>>, relativePath: string) {
  const file = files.find((candidate) => candidate.relativePath === relativePath);
  return file && Buffer.from(file.contentBase64, 'base64').toString();
}

test('collectSupportFiles copies an in-root file link as its target content', async (t) => {
  const { root } = await tree(t);
  await writeFile(path.join(root, 'actions/run.ts'), 'export const x = 1;\n', { mode: 0o755 });
  await symlink('run.ts', path.join(root, 'actions/run.mjs'));

  const files = await collectSupportFiles(root, 'lib');
  const link = files.find((file) => file.relativePath === 'lib/actions/run.mjs');

  assert.equal(contentOf(files, 'lib/actions/run.mjs'), 'export const x = 1;\n');
  assert.equal(link?.mode, 0o755);
  assert.equal(
    link?.sha256,
    files.find((file) => file.relativePath === 'lib/actions/run.ts')?.sha256,
  );
});

test('collectSupportFiles refuses a link that escapes the root, even through ..', async (t) => {
  const { base, root } = await tree(t);
  await writeFile(path.join(base, 'outside.txt'), 'secret');
  await symlink('../../outside.txt', path.join(root, 'actions/leak.txt'));

  await assert.rejects(
    collectSupportFiles(root, 'lib'),
    /refuses symlink .*actions\/leak\.txt: it resolves to .*outside\.txt, outside /,
  );
});

test('collectSupportFiles refuses a dangling link', async (t) => {
  const { root } = await tree(t);
  await symlink('missing.ts', path.join(root, 'actions/gone.mjs'));

  await assert.rejects(
    collectSupportFiles(root, 'lib'),
    /refuses symlink .*actions\/gone\.mjs: its target does not resolve \(ENOENT\)/,
  );
});

test('collectSupportFiles walks an in-root directory link like a directory', async (t) => {
  const { root } = await tree(t);
  await writeFile(path.join(root, 'actions/a.ts'), 'a');
  await symlink('actions', path.join(root, 'alias'));

  const files = await collectSupportFiles(root, 'lib');

  assert.deepEqual(files.map((file) => file.relativePath).sort(), [
    'lib/actions/a.ts',
    'lib/alias/a.ts',
  ]);
  assert.equal(contentOf(files, 'lib/alias/a.ts'), 'a');
});

test('collectSupportFiles refuses a directory link that loops back to an ancestor', async (t) => {
  const { root } = await tree(t);
  await symlink('..', path.join(root, 'actions/up'));

  await assert.rejects(
    collectSupportFiles(root, 'lib'),
    /refuses symlink .*actions\/up: it loops back to /,
  );
});

test('a materialized x.mjs -> x.ts action runs like the linked source under tsx', async (t) => {
  // recipe-perps shape: `x.mjs -> x.ts` beside `x.ts`, which imports a typed
  // sibling module. The live adapter runs `<file>.mjs <input>` under tsx because
  // the file imports `.ts` source (recipe-cli live-adapter-contract commandFor).
  const { base, root } = await tree(t);
  await writeFile(
    path.join(root, 'actions/recovery.ts'),
    'export function answer(action: string): string {\n  return `${action}:${process.argv[2]}`;\n}\n',
  );
  await writeFile(
    path.join(root, 'actions/acknowledge.ts'),
    'import { answer } from "./recovery.ts";\n\nconsole.log(answer("ack"));\n',
  );
  await symlink('acknowledge.ts', path.join(root, 'actions/acknowledge.mjs'));

  const workspace = path.join(base, 'workspace');
  for (const file of await collectSupportFiles(root, 'libraries/perps')) {
    await mkdir(path.dirname(path.join(workspace, file.relativePath)), { recursive: true });
    await writeFile(
      path.join(workspace, file.relativePath),
      Buffer.from(file.contentBase64, 'base64'),
      {
        mode: file.mode,
      },
    );
  }

  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  // Not this test runner's own tsx/test settings: run like a standalone child.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('TSX_') && name !== 'NODE_TEST_CONTEXT',
    ),
  );
  const run = (file: string) =>
    promisify(execFile)(process.execPath, [tsx, file, 'input.json'], { cwd: base, env });
  const source = await run(path.join(root, 'actions/acknowledge.mjs'));
  const materialized = await run(path.join(workspace, 'libraries/perps/actions/acknowledge.mjs'));

  assert.equal(source.stdout, 'ack:input.json\n');
  assert.equal(materialized.stdout, source.stdout);
});
