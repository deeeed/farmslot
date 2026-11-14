import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test('native auth environment remains inherited but is absent from durable state', async () => {
  const fixture = setup();
  const originalKey = process.env.CODEX_LB_API_KEY;
  const originalMarker = process.env.CLAUDECODE;
  process.env.CODEX_LB_API_KEY = 'fixture-native-route';
  process.env.CLAUDECODE = 'parent-context';
  const executable = join(fixture.cwd, 'codex');
  writeFileSync(
    executable,
    readFileSync(executable, 'utf8').replace(
      "const fs = require('node:fs');",
      "if(process.env.CODEX_LB_API_KEY!=='fixture-native-route'||process.env.CLAUDECODE)process.exit(24);\nconst fs = require('node:fs');",
    ),
  );
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    assert.ok(
      !readFileSync(join(fixture.root, `${session.id}.journal`), 'utf8').includes(
        'fixture-native-route',
      ),
    );
    await manager.close('owner', session.id);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        manager.create('owner', {
          runner: 'codex',
          cwd: fixture.cwd,
          resumeSessionId: session.nativeSessionId,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    if (originalKey === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = originalKey;
    if (originalMarker === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = originalMarker;
    fixture.restore();
  }
});

test('native host storage follows FARMSLOT_HOME and its explicit override', () => {
  const home = process.env.FARMSLOT_HOME;
  const override = process.env.FARMSLOT_NATIVE_STATE_DIR;
  try {
    process.env.FARMSLOT_HOME = '/tmp/native-instance-home';
    delete process.env.FARMSLOT_NATIVE_STATE_DIR;
    assert.equal(new NativeSessionClient().root, '/tmp/native-instance-home/native-sessions');
    process.env.FARMSLOT_NATIVE_STATE_DIR = '/tmp/native-explicit-state';
    assert.equal(new NativeSessionClient().root, '/tmp/native-explicit-state');
  } finally {
    if (home === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = home;
    if (override === undefined) delete process.env.FARMSLOT_NATIVE_STATE_DIR;
    else process.env.FARMSLOT_NATIVE_STATE_DIR = override;
  }
});
