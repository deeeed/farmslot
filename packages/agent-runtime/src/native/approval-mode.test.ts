import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { decodeRequest } from './ipc.js';
import { NativeSessionManager } from './manager.js';

// Native wire fixture only. The live recipe proves real provider tools separately.
const fixture = `#!${process.execPath}
const fs = require('node:fs');
if(process.argv.includes('--version')) {console.log('fixture 1');process.exit(0)}
fs.writeFileSync('argv',JSON.stringify(process.argv.slice(2)));
const sid=process.argv[process.argv.indexOf('--session-id')+1];
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync('wire',line+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:m.params.threadId||'native-conversation'}}});
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'turn-'+m.id}}});
  send({method:'turn/started',params:{turn:{id:'turn-'+m.id}}});
  send({method:'turn/completed',params:{turn:{id:'turn-'+m.id,status:'completed'}}});
 }
 if(m.type==='control_request')send({type:'control_response',response:{request_id:m.request_id,
  subtype:m.request.subtype==='set_permission_mode'&&fs.existsSync('refuse-mode')?'error':'success',response:{}}});
 if(m.type==='user'){
  send({...m,session_id:sid});
  send({type:'assistant',session_id:sid,message:{content:[]}});
  send({type:'result',session_id:sid,subtype:'success',is_error:false,result:'done'});
 }
});`;

for (const runner of ['claude', 'codex']) {
  test(`${runner} approval mode persists and changes on the same idle conversation`, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'native-approval-'));
    const oldPath = process.env.PATH;
    const root = join(cwd, 'state');
    writeFileSync(join(cwd, runner), fixture);
    chmodSync(join(cwd, runner), 0o700);
    process.env.PATH = cwd + delimiter + oldPath;
    const manager = new NativeSessionManager(root);
    let id: string | undefined;
    t.after(async () => {
      if (id) await manager.close('owner', id);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(cwd, { recursive: true, force: true });
    });
    const created = await manager.create('owner', { runner, cwd, approvalMode: 'bypass' });
    id = created.id;
    assert.equal(created.approvalMode, 'bypass');
    assert.deepEqual(created.capabilities.approvalModes, ['ask', 'bypass']);
    const changed = await manager.setApprovalMode('owner', id, 'ask');
    assert.equal(changed.id, id);
    assert.equal(changed.nativeSessionId, created.nativeSessionId);
    assert.equal(changed.generation, created.generation);
    assert.equal(changed.approvalMode, 'ask');
    await manager.send('owner', id, 'ask-command', 'test');
    const end = Date.now() + 3000;
    while (
      manager.read('owner', id).commands.find((c) => c.commandId === 'ask-command')?.state !==
      'completed'
    ) {
      assert.ok(Date.now() < end, 'fixture turn settles');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const wire = readFileSync(join(cwd, 'wire'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (runner === 'codex') {
      assert.equal(wire.find((m) => m.method === 'thread/start').params.approvalPolicy, 'never');
      assert.equal(
        wire.find((m) => m.method === 'thread/start').params.sandbox,
        'danger-full-access',
      );
      assert.equal(wire.find((m) => m.method === 'turn/start').params.approvalPolicy, 'untrusted');
      assert.equal(
        wire.find((m) => m.method === 'turn/start').params.sandboxPolicy.type,
        'workspaceWrite',
      );
    } else {
      const argv = JSON.parse(readFileSync(join(cwd, 'argv'), 'utf8'));
      assert.ok(argv.includes('--dangerously-skip-permissions'));
      assert.ok(argv.includes('--allow-dangerously-skip-permissions'));
      assert.equal(
        wire.find((m) => m.request?.subtype === 'set_permission_mode').request.mode,
        'default',
      );
      writeFileSync(join(cwd, 'refuse-mode'), '1');
      await assert.rejects(manager.setApprovalMode('owner', id, 'bypass'), /rejected/);
      assert.equal(manager.read('owner', id).session.approvalModePending, 'bypass');
      await assert.rejects(manager.send('owner', id, 'unsafe', 'no'), /unconfirmed/);
      rmSync(join(cwd, 'refuse-mode'));
      await manager.setApprovalMode('owner', id, 'ask');
      assert.equal(manager.read('owner', id).session.approvalModePending, undefined);
    }
    await manager.close('owner', id);
    assert.equal(new NativeSessionManager(root).read('owner', id).session.approvalMode, 'ask');
    assert.ok(existsSync(join(root, id + '.journal')));
  });
}

test('IPC refuses invalid policy names and never accepts a worker approval override', () => {
  assert.throws(
    () =>
      decodeRequest({
        method: 'setApprovalMode',
        owner: 'owner',
        id: 'session',
        approvalMode: 'dangerous',
      }),
    /Unknown native approval mode/,
  );
  assert.throws(
    () =>
      decodeRequest({
        method: 'native.worker.ensure',
        owner: 'owner',
        params: { runner: 'codex', cwd: '/tmp', approvalMode: 'bypass' },
      }),
    /Workers retain their launch approval policy/,
  );
});

test('new Claude ask explicitly resets the native policy before any input can be sent', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-ask-default-'));
  const oldPath = process.env.PATH;
  writeFileSync(join(cwd, 'claude'), fixture);
  chmodSync(join(cwd, 'claude'), 0o700);
  process.env.PATH = cwd + delimiter + oldPath;
  const manager = new NativeSessionManager(join(cwd, 'state'));
  let id: string | undefined;
  t.after(async () => {
    if (id) await manager.close('owner', id);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(cwd, { recursive: true, force: true });
  });
  const session = await manager.create('owner', { runner: 'claude', cwd });
  id = session.id;
  assert.equal(session.approvalMode, 'ask');
  const wire = readFileSync(join(cwd, 'wire'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(
    wire.find((m) => m.request?.subtype === 'set_permission_mode').request.mode,
    'default',
  );
  assert.equal(
    wire.some((m) => m.type === 'user'),
    false,
  );
  assert.equal(
    JSON.parse(readFileSync(join(cwd, 'argv'), 'utf8')).includes('--dangerously-skip-permissions'),
    false,
  );
});
