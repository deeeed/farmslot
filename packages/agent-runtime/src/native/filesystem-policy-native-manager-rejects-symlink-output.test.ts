import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { fixture } from '../../test/native-filesystem-fixture.mjs';

import { NativeSessionManager } from './manager.js';

test('native manager rejects symlink output aliases and grants covering its private state before launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-policy-paths-'));
  const source = join(root, 'source');
  const state = join(root, 'state');
  const alias = join(root, 'output-alias');
  const executable = join(root, 'runner');
  try {
    await mkdir(source);
    await symlink(source, alias);
    await writeFile(executable, '#!/bin/sh\necho "codex-cli 0.154.0"\n');
    await chmod(executable, 0o755);
    const manager = new NativeSessionManager(state);
    for (const output of [alias, state]) {
      await assert.rejects(
        manager.ensure(
          'owner',
          {
            sessionId: '10000000-0000-4000-8000-000000000001',
            runner: 'codex',
            cwd: source,
          },
          {
            leaseId: '20000000-0000-4000-8000-000000000002',
            executable,
            safetyTier: 'sandboxed',
            environment: { set: {}, unset: [] },
            filesystemPolicy: { readOnlyRoots: [source], writableRoots: [output] },
          },
        ),
        /must not overlap/,
      );
    }
    assert.deepEqual(manager.list('owner'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a source policy supports exact saved-session recovery and does not advertise relocation', async () => {
  const f = await fixture(true);
  const source = join(f.root, 'source');
  const output = join(f.root, 'output');
  await mkdir(source);
  await mkdir(output);
  const manager = new NativeSessionManager(join(f.root, 'state'));
  const sessionId = '10000000-0000-4000-8000-000000000001';
  const launch = {
    leaseId: '20000000-0000-4000-8000-000000000002',
    executable: f.executable,
    safetyTier: 'sandboxed' as const,
    environment: { set: {}, unset: [] },
    filesystemPolicy: { readOnlyRoots: [source], writableRoots: [output] },
  };
  try {
    const info = await manager.ensure('owner', { sessionId, cwd: source, runner: 'codex' }, launch);
    assert.equal(info.capabilities.resumeAcrossWorkspaces, false);
    await manager.close('owner', sessionId);
    const resumed = await manager.resumeWorker(
      'owner',
      {
        sessionId,
        cwd: source,
        runner: 'codex',
        resumeSessionId: info.nativeSessionId,
        generation: info.generation,
        commandId: 'resume-command',
      },
      launch,
    );
    assert.equal(resumed.nativeSessionId, info.nativeSessionId);
    assert.notEqual(resumed.generation, info.generation);
    assert.equal(resumed.workerLeaseId, launch.leaseId);
    assert.equal(resumed.capabilities.resumeAcrossWorkspaces, false);
  } finally {
    await manager.close('owner', sessionId);
    await rm(f.root, { recursive: true, force: true });
  }
});
