import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixture, setup } from './acp.test-support.js';
import { opencodeEnvironment } from './opencode.js';

test('Grok resumes the same named account when HOME becomes isolated', async () => {
  const { NativeSessionManager } = await import('./manager.js');
  const { addNativeProfile } = await import('./account-profiles.js');
  const { nativeRunnerDefinitions } = await import('./registry.js');
  const f = setup();
  const oldPath = process.env.PATH;
  const oldHome = process.env.FARMSLOT_HOME;
  const oldGrokHome = process.env.GROK_HOME;
  const definition = nativeRunnerDefinitions.grok;
  const environment = definition.account.environment;
  const manager = new NativeSessionManager(join(f.cwd, 'state'));
  let id: string | undefined;
  try {
    process.env.FARMSLOT_HOME = join(f.cwd, 'registry');
    process.env.PATH = `${f.cwd}:${oldPath}`;
    writeFileSync(join(f.cwd, 'grok'), fixture, { mode: 0o700 });
    const profile = await addNativeProfile({ profileId: 'grok-review', runner: 'grok' });
    definition.account.environment = (directory) => ({ GROK_HOME: directory });
    const original = await manager.create('owner', {
      runner: 'grok',
      cwd: f.cwd,
      profileId: profile.id,
      accountContextId: profile.accountContextId,
    });
    id = original.id;
    await manager.close('owner', id);
    definition.account.environment = environment;
    const resumed = await manager.create('owner', {
      runner: 'grok',
      cwd: f.cwd,
      profileId: profile.id,
      accountContextId: profile.accountContextId,
      resumeSessionId: original.nativeSessionId,
    });
    id = resumed.id;
    assert.equal(resumed.nativeSessionId, original.nativeSessionId);
    assert.equal(resumed.accountContextId, profile.accountContextId);
    await manager.close('owner', id);
    process.env.GROK_HOME = '/changed-account';
    await assert.rejects(
      manager.create('owner', {
        runner: 'grok',
        cwd: f.cwd,
        resumeSessionId: original.nativeSessionId,
      }),
      /account execution context/,
    );
  } finally {
    definition.account.environment = environment;
    if (id) await manager.close('owner', id);
    if (oldHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = oldGrokHome;
    f.cleanup();
  }
});

test('OpenCode read-only reviews disable project startup configuration without changing ordinary sessions', () => {
  const options = { cwd: '/w', executable: 'opencode' };
  assert.equal(opencodeEnvironment(options).OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
  assert.equal(
    opencodeEnvironment({
      ...options,
      filesystemPolicy: { readOnlyRoots: ['/source'], writableRoots: ['/task'] },
    }).OPENCODE_DISABLE_PROJECT_CONFIG,
    'true',
  );
});

test('OpenCode read-only review permits declared inputs and denies other external directories only in read-only review', () => {
  const env = opencodeEnvironment({
    cwd: '/source',
    executable: 'opencode',
    processSandbox: { executable: '/usr/bin/sandbox-exec', args: [] },
    modelQuestions: 'off',
    filesystemPolicy: { readOnlyRoots: ['/source', '/frozen/support'], writableRoots: ['/task'] },
  });
  assert.deepEqual(JSON.parse(env.OPENCODE_PERMISSION), {
    question: 'deny',
    external_directory: {
      '*': 'deny',
      '/source/*': 'allow',
      '/frozen/support/*': 'allow',
      '/task/*': 'allow',
    },
  });
});
