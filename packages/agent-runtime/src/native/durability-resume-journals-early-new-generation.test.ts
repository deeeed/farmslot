import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixture, setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive, appendDurable } from './storage.js';

test('resume journals the early new-generation census before host reload', async () => {
  const fixtureState = setup();
  writeFileSync(
    join(fixtureState.cwd, 'codex'),
    fixture.replace(
      "thread=m.params.threadId || 'thread-'+process.pid;",
      "const early=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});fs.writeFileSync('early-descendant',String(early.pid));thread=m.params.threadId || 'thread-'+process.pid;",
    ),
  );
  const manager = new NativeSessionManager(fixtureState.root);
  let restored: NativeSessionManager | undefined;
  try {
    const first = await manager.create('owner', { runner: 'codex', cwd: fixtureState.cwd });
    const journal = join(fixtureState.root, `${first.id}.journal`);
    const firstChild = Number(readFileSync(join(fixtureState.cwd, 'early-descendant'), 'utf8'));
    await until(() => readFileSync(journal, 'utf8').includes(`"pid":${firstChild},`));
    await manager.close('owner', first.id);
    const resumed = await manager.create('owner', {
      runner: 'codex',
      cwd: fixtureState.cwd,
      resumeSessionId: first.nativeSessionId,
    });
    const nextChild = Number(readFileSync(join(fixtureState.cwd, 'early-descendant'), 'utf8'));
    await until(() => readFileSync(journal, 'utf8').includes(`"pid":${nextChild},`));
    assert.notEqual(resumed.generation, first.generation);
    // A stale leader pointer must not erase the early new-generation census.
    // The first generation's actual leader has stopped, while the resumed tree lives.
    assert.equal(alive(first.processPid!), false);
    appendDurable(journal, {
      info: { ...resumed, state: 'failed', processStopped: false, processPid: first.processPid },
    });
    restored = new NativeSessionManager(fixtureState.root);
    assert.equal(
      restored.read('owner', resumed.id).session.processStopped,
      false,
      'The early detached descendant remains owned after reload',
    );
    assert.equal(alive(nextChild), true);
    await assert.rejects(
      restored.create('owner', {
        runner: 'codex',
        cwd: fixtureState.cwd,
        resumeSessionId: resumed.nativeSessionId,
      }),
      /cleanup is unconfirmed/,
    );
    await manager.close('owner', resumed.id);
    await until(() => !alive(nextChild));
    await restored.close('owner', resumed.id);
  } finally {
    try {
      for (const session of manager.list('owner')) await manager.close('owner', session.id);
      if (restored)
        for (const session of restored.list('owner')) await restored.close('owner', session.id);
    } finally {
      fixtureState.restore();
    }
  }
});
