import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { fixture } from '../../test/native-filesystem-fixture.mjs';

import { claudeNativeAdapter } from './claude.js';
import { codexNativeAdapter } from './codex.js';

export const readOnlyModes = [false, true];
export function registerHookPolicy(variant: (typeof readOnlyModes)[number]) {
  const readonly = variant;
  test(`stream-json ${readonly ? 'read-only reviews skip project settings and hooks' : 'ordinary workers keep their settings and hooks'}`, async () => {
    const f = await fixture(true);
    let session;
    try {
      session = await claudeNativeAdapter.start(
        {
          cwd: f.root,
          executable: f.executable,
          ...(readonly
            ? { filesystemPolicy: { readOnlyRoots: [f.root], writableRoots: [`${f.root}-output`] } }
            : {}),
        },
        () => {},
      );
      const argv: string[] = JSON.parse(await readFile(f.argv, 'utf8'));
      const settings = argv.indexOf('--settings');
      const sources = argv.indexOf('--setting-sources');
      if (readonly) {
        assert.notEqual(sources, -1, 'denied PR settings must never be loaded at startup');
        assert.equal(argv[sources + 1], 'user');
        assert.deepEqual(JSON.parse(argv[settings + 1]), { disableAllHooks: true });
      } else {
        assert.equal(sources, -1);
        assert.equal(settings, -1);
      }
    } finally {
      await session?.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

export const workerResumeModes = [false, true];
export function registerProducingWorkerScope(variant: (typeof workerResumeModes)[number]) {
  const resume = variant;
  test(`sandboxed reviewer ${resume ? 'resume' : 'start'} executes a command without approval and keeps its write scope`, async () => {
    const f = await fixture(true);
    let session;
    let finish = () => {};
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let approvals = 0;
    try {
      session = await codexNativeAdapter.start(
        {
          cwd: f.root,
          executable: f.executable,
          safetyTier: 'sandboxed',
          approvalPolicy: 'never',
          ...(resume ? { resumeSessionId: 'thread' } : {}),
        },
        (event) => {
          if (event.type === 'approval.requested') approvals++;
          if (event.type === 'turn.completed') finish();
        },
      );
      const messages = (await readFile(f.requests, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const request = messages.find(
        (message) => message.method === (resume ? 'thread/resume' : 'thread/start'),
      ).params;
      assert.equal(request.approvalPolicy, 'never');
      assert.equal(request.sandbox, 'workspace-write');
      await session.send('execute fixture command', 'command');
      await completed;
      assert.equal(await readFile(join(f.root, 'command-ran'), 'utf8'), 'ok');
      assert.equal(approvals, 0);
    } finally {
      await session?.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

export {};
