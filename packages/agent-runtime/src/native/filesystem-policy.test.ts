import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { DEFAULT_CODEX_EFFORT } from '@farmslot/protocol';

import { fixture } from '../../test/native-filesystem-fixture.mjs';

import { codexNativeAdapter } from './codex.js';
import { nativeRunnerDefinitions } from './registry.js';

test('source policy omits legacy writable cwd, pins exact output roots and refuses unconfirmed profile', async () => {
  for (const confirm of [true, false]) {
    const f = await fixture(confirm);
    let session;
    try {
      const operation = codexNativeAdapter.start(
        {
          cwd: f.root,
          executable: f.executable,
          safetyTier: 'sandboxed',
          filesystemPolicy: { readOnlyRoots: [f.root], writableRoots: [`${f.root}-output`] },
        },
        () => {},
      );
      if (confirm) session = await operation;
      else await assert.rejects(operation, /did not confirm/);
      const messages = (await readFile(f.requests, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const argv = JSON.parse(await readFile(f.argv, 'utf8'));
      assert.deepEqual(argv, [
        '--config',
        `projects={${JSON.stringify(f.root)}={trust_level="untrusted"}}`,
        '--config',
        'features.hooks=false',
        'app-server',
      ]);
      const request = messages.find((message) => message.method === 'thread/start').params;
      assert.equal(request.cwd, f.root);
      assert.equal(request.approvalPolicy, 'never');
      assert.equal(request.sandbox, undefined);
      assert.deepEqual(request.config['permissions.farmslot-read-only-source'].filesystem, {
        '/': 'read',
        [`${f.root}-output`]: 'write',
      });
      assert.equal(
        messages.some((message) => message.method === 'turn/start'),
        false,
      );
    } finally {
      await session?.close();
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('native coding runner declares the framework default effort', () => {
  assert.equal(nativeRunnerDefinitions.codex.defaultEffort, DEFAULT_CODEX_EFFORT);
});

test('ordinary app-server conversations preserve hook configuration', async () => {
  const f = await fixture(true);
  let session;
  try {
    session = await codexNativeAdapter.start(
      { cwd: f.root, executable: f.executable, safetyTier: 'sandboxed' },
      () => {},
    );
    assert.deepEqual(JSON.parse(await readFile(f.argv, 'utf8')), ['app-server']);
  } finally {
    await session?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
