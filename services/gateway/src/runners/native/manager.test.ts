import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { NativeSessionManager } from './manager.js';

const fixture = `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('native-fixture 1'); process.exit(0); }
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start' || m.method==='thread/resume') send({id:m.id,result:{thread:{id:'owned-thread'}}});
 if(m.method==='turn/start') send({id:m.id,result:{turn:{id:'accepted-but-not-started'}}});
});`;

test('manager owns exact sessions and gates new input until the accepted turn runs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-manager-test-'));
  const oldPath = process.env.PATH;
  const executable = join(cwd, 'codex');
  await writeFile(executable, fixture);
  await chmod(executable, 0o755);
  process.env.PATH = `${cwd}${delimiter}${oldPath}`;
  const manager = new NativeSessionManager(join(cwd, 'state'));
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd });
    assert.deepEqual(manager.list('other'), []);
    assert.throws(() => manager.read('other', session.id), /not found/);
    await assert.rejects(manager.close('other', session.id), /not found/);
    await assert.rejects(
      manager.create('other', { runner: 'codex', cwd, resumeSessionId: session.nativeSessionId }),
      /owned/,
    );
    await assert.rejects(
      manager.create('owner', { runner: 'codex', cwd, resumeSessionId: session.nativeSessionId }),
      /input owner/,
    );
    await manager.send('owner', session.id, 'first', 'hello');
    assert.equal(manager.read('owner', session.id).session.state, 'waiting');
    await manager.send('owner', session.id, 'first', 'hello');
    await assert.rejects(manager.send('owner', session.id, 'first', 'different'), /different text/);
    await assert.rejects(manager.send('owner', session.id, 'second', 'next'), /not idle/);
    await assert.rejects(
      manager.respond('owner', session.id, 'foreign', { decision: 'approve' }),
      /stale/,
    );
    const closing = manager.close('owner', session.id);
    assert.equal(manager.read('owner', session.id).session.state, 'closing');
    await closing;
    await assert.rejects(manager.send('owner', session.id, 'closed', 'next'), /not idle/);
    const resumed = await manager.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.equal(resumed.nativeSessionId, session.nativeSessionId);
    await manager.close('owner', resumed.id);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('closing during startup waits for and terminates the reserved input owner', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-manager-startup-'));
  const executable = join(cwd, 'codex');
  const release = join(cwd, 'release');
  const pidFile = join(cwd, 'pid');
  const oldPath = process.env.PATH;
  await writeFile(
    executable,
    `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') { const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);send({id:m.id,result:{}});}},10); }
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'startup-thread'}}});
});`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${cwd}${delimiter}${oldPath}`;
  const manager = new NativeSessionManager(join(cwd, 'state'));
  const creating = manager.create('owner', { runner: 'codex', cwd });
  t.after(async () => {
    try {
      await writeFile(release, 'ready');
      await creating;
      for (const session of manager.list('owner')) await manager.close('owner', session.id);
      // Clean the fixture even if a regression released its owner too early.
      try {
        process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });
  for (let attempt = 0; !manager.list('owner').length && attempt < 200; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const reserved = manager.list('owner')[0];
  assert.ok(reserved);
  assert.equal(reserved.state, 'starting');
  const closing = manager.close('owner', reserved.id);
  assert.equal(manager.read('owner', reserved.id).session.state, 'closing');
  await writeFile(release, 'ready');
  await Promise.all([creating, closing]);
  assert.equal(manager.read('owner', reserved.id).session.state, 'closed');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('close retains a failed terminal outcome instead of synthesizing success', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-manager-close-failure-'));
  const executable = join(cwd, 'codex');
  const oldPath = process.env.PATH;
  await writeFile(executable, fixture + "\nprocess.on('SIGTERM',()=>process.exit(23));\n");
  await chmod(executable, 0o755);
  process.env.PATH = `${cwd}${delimiter}${oldPath}`;
  const manager = new NativeSessionManager(join(cwd, 'state'));
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd });
    await manager.close('owner', session.id);
    const result = manager.read('owner', session.id);
    assert.equal(result.session.state, 'failed');
    assert.deepEqual(
      result.events.filter((event) => event.type === 'session.closed').map((event) => event.status),
      ['failed'],
    );
    await manager.close('owner', session.id);
    assert.equal(manager.read('owner', session.id).session.state, 'failed');
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('early interrupt targets the accepted native turn before its first turn event', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-early-interrupt-'));
  const oldPath = process.env.PATH;
  await writeFile(
    join(cwd, 'codex'),
    fixture.replace(
      " if(m.method==='turn/start')",
      " if(m.method==='turn/interrupt') { send({id:m.id,result:{}}); send({method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'accepted-but-not-started',status:'interrupted'}}}); }\n if(m.method==='turn/start')",
    ),
  );
  await chmod(join(cwd, 'codex'), 0o755);
  process.env.PATH = `${cwd}${delimiter}${oldPath}`;
  const manager = new NativeSessionManager(join(cwd, 'state'));
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd });
    await manager.send('owner', session.id, 'early', 'interrupt this');
    assert.equal(manager.read('owner', session.id).session.state, 'waiting');
    await manager.interrupt('owner', session.id);
    for (
      let attempt = 0;
      manager.read('owner', session.id).session.state !== 'idle' && attempt < 100;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = manager.read('owner', session.id);
    assert.equal(snapshot.commands[0]?.outcome, 'interrupted');
    assert.equal(
      snapshot.events.some((event) => event.type === 'turn.started'),
      false,
    );
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(cwd, { recursive: true, force: true });
  }
});
