import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test('fresh empty thread evidence survives stop and reload; a submitted request clears it before a lost reply', async (t) => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  let reloaded = manager;
  t.after(async () => {
    try {
      for (const active of reloaded.list('owner')) await reloaded.close('owner', active.id);
    } finally {
      fixture.restore();
    }
  });
  const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
  assert.equal(session.nativeSessionHasInput, false);
  await manager.close('owner', session.id);
  reloaded = new NativeSessionManager(fixture.root);
  assert.equal(reloaded.read('owner', session.id).session.nativeSessionHasInput, false);
  const resumed = await reloaded.create('owner', {
    runner: 'codex',
    cwd: fixture.cwd,
    resumeSessionId: session.nativeSessionId,
  });

  assert.equal(resumed.nativeSessionHasInput, false);
  await assert.rejects(reloaded.send('owner', resumed.id, 'unknown', 'unknown'));
  assert.equal(reloaded.read('owner', resumed.id).session.nativeSessionHasInput, true);
  const entries = readFileSync(join(fixture.root, `${session.id}.journal`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const submitted = entries.find((entry) => entry.event?.type === 'command.submitted');
  assert.equal(
    submitted.info.nativeSessionHasInput,
    true,
    'evidence changes in the durable pre-send entry',
  );
  await reloaded.close('owner', resumed.id);
  reloaded = new NativeSessionManager(fixture.root);
  assert.equal(reloaded.read('owner', resumed.id).session.nativeSessionHasInput, true);
  const materialized = await reloaded.create('owner', {
    runner: 'codex',
    cwd: fixture.cwd,
    resumeSessionId: session.nativeSessionId,
  });
  assert.equal(materialized.nativeSessionHasInput, true, 'resume never resets input evidence');
});

test('legacy missing evidence stays unknown after resume', async (t) => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
  await manager.close('owner', session.id);
  appendFileSync(
    join(fixture.root, `${session.id}.journal`),
    JSON.stringify({
      info: { ...manager.read('owner', session.id).session, nativeSessionHasInput: undefined },
    }) + '\n',
  );
  const reloaded = new NativeSessionManager(fixture.root);
  t.after(async () => {
    try {
      for (const active of reloaded.list('owner')) await reloaded.close('owner', active.id);
    } finally {
      fixture.restore();
    }
  });
  const resumed = await reloaded.create('owner', {
    runner: 'codex',
    cwd: fixture.cwd,
    resumeSessionId: session.nativeSessionId,
  });

  assert.equal(resumed.nativeSessionHasInput, undefined);
});
