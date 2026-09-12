import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const manager = new NativeSessionManager();
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
