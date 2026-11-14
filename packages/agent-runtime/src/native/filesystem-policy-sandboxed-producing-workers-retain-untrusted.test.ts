import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { fixture } from '../../test/native-filesystem-fixture.mjs';

import { codexNativeAdapter } from './codex.js';

test('sandboxed producing workers retain untrusted approval and workspace write scope', async () => {
  const f = await fixture(true);
  let session;
  try {
    session = await codexNativeAdapter.start(
      { cwd: f.root, executable: f.executable, safetyTier: 'sandboxed' },
      () => {},
    );
    const messages = (await readFile(f.requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const request = messages.find((message) => message.method === 'thread/start').params;
    assert.equal(request.approvalPolicy, 'untrusted');
    assert.equal(request.sandbox, 'workspace-write');
  } finally {
    await session?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
