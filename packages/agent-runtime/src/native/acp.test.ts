import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acpPermission, cursorRequest } from './acp-requests.js';
import { cursorNativeAdapter } from './cursor.js';
import { grokNativeAdapter } from './grok.js';
import type { NativeEventInput } from './types.js';

const fixture = `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const fs=require('node:fs');
let session='fixture-session',prompt,authenticated=false;
const configOptions=[{id:'model',currentValue:'specific-model',options:[{value:'specific-model'}]}];
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const update=u=>send({method:'session/update',params:{sessionId:session,update:u}});
const result=(id,value)=>send({id,result:value});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync('wire',line+'\\n');
 if(m.jsonrpc!=='2.0')process.exit(9);
 if(m.method==='initialize')return result(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'},{id:'cached_token'}]});
 if(m.method==='authenticate'){authenticated=true;return result(m.id,{})}
 if(m.method==='session/new'||m.method==='session/load'){
  if(!authenticated)process.exit(10);
  if(m.method==='session/load') {session=m.params.sessionId;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REPLAY'}})}
  return result(m.id,{...(m.method==='session/new'?{sessionId:session}:{}),modes:{availableModes:[{id:'agent'},{id:'plan'}]},configOptions});
 }
 if(m.method==='session/set_config_option'){configOptions[0].currentValue=m.params.value;return result(m.id,{configOptions});}
 if(m.method==='session/set_model'||m.method==='session/set_mode')return result(m.id,{});
 if(m.method==='session/prompt'){
  prompt=m.id;const text=m.params.prompt[0].text;
  if(text==='malformed')return result(prompt,{});
  if(text==='error')return send({id:prompt,error:{code:-32000,message:'fixture failure'}});
  if(text==='silent')return;
  send({method:'session/update',params:{sessionId:'other-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOREIGN'}}}});
  if(text==='permission')return send({id:71,method:'session/request_permission',params:{sessionId:session,toolCall:{title:'Write fixture',rawInput:{path:'fixture'}},options:[{optionId:'allow-once',kind:'allow_once'},{optionId:'deny-once',kind:'reject_once'}]}});
  if(text==='unknown')return send({id:72,method:'fs/read_text_file',params:{path:'/private'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ANSWER'}});
  update({sessionUpdate:'tool_call',toolCallId:'tool1',title:'read fixture',status:'in_progress',rawInput:{path:'fixture'}});
  update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'completed',rawOutput:'data'});
  update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'completed',rawOutput:'data'});
  return result(prompt,{stopReason:'end_turn'});
 }
 if(m.method==='session/cancel')return result(prompt,{stopReason:'cancelled'});
 if(m.id===71&&!m.method){fs.writeFileSync('permission',JSON.stringify(m.result));return result(prompt,{stopReason:'end_turn'})}
 if(m.id===72&&!m.method){fs.writeFileSync('unsupported',JSON.stringify(m.error));return result(prompt,{stopReason:'end_turn'})}
});`;
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('ACP fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'farmslot-acp-'));
  const executable = join(cwd, 'runner');
  writeFileSync(executable, fixture);
  chmodSync(executable, 0o700);
  return { cwd, executable, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

for (const [runner, adapter] of [
  ['cursor', cursorNativeAdapter],
  ['grok', grokNativeAdapter],
] as const) {
  test(`${runner} ACP excludes replay/foreign updates and retains exact identity`, async () => {
    const f = setup();
    const events: NativeEventInput[] = [];
    const session = await adapter.start(
      { ...f, resumeSessionId: 'saved-identity', model: 'specific-model' },
      (event) => events.push(event),
    );
    try {
      assert.equal(session.nativeSessionId, 'saved-identity');
      assert.equal(events.filter((e) => e.type === 'text.delta').length, 0);
      await session.send('silent', 'c1');
      assert.equal(events.filter((e) => e.type === 'command.accepted').length, 0);
      await assert.rejects(session.send('second', 'c2'), /still active/);
      await session.interrupt();
      await until(() => events.some((e) => e.type === 'turn.completed'));
      assert.equal(events.find((e) => e.type === 'turn.completed')?.status, 'interrupted');
      await session.send('text', 'c2');
      await until(() => events.filter((e) => e.type === 'turn.completed').length === 2);
      assert.deepEqual(
        events.filter((e) => e.type === 'text.delta').map((e) => e.text),
        ['ANSWER'],
      );
      assert.equal(events.filter((e) => e.type === 'tool.completed').length, 1);
      assert.deepEqual(
        events.filter((e) => e.type === 'command.accepted').map((e) => e.commandId),
        ['c1', 'c2'],
      );
      const calls = readFileSync(join(f.cwd, 'wire'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(calls.every((call) => call.jsonrpc === '2.0'));
      assert.equal(
        calls.find(
          (call) =>
            call.method ===
            (runner === 'cursor' ? 'session/set_config_option' : 'session/set_model'),
        ).params[runner === 'cursor' ? 'value' : 'modelId'],
        'specific-model',
      );
      await session.close();
      assert.equal(events.at(-1)?.data?.processStopped, true);
    } finally {
      await session.close();
      f.cleanup();
    }
  });
}

test('ACP permission ownership, one-time denial and unsupported host operations', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await cursorNativeAdapter.start(f, (event) => events.push(event));
  try {
    await session.send('permission', 'c1');
    await until(() => events.some((e) => e.type === 'approval.requested'));
    await assert.rejects(session.respond('foreign', { decision: 'approve' }), /stale/);
    const request = events.find((e) => e.type === 'approval.requested')!;
    await session.respond(request.nativeId!, { decision: 'deny' });
    await until(() => events.some((e) => e.type === 'turn.completed'));
    assert.equal(
      JSON.parse(readFileSync(join(f.cwd, 'permission'), 'utf8')).outcome.optionId,
      'deny-once',
    );
    await assert.rejects(session.respond(request.nativeId!, { decision: 'approve' }), /stale/);
    await session.send('unknown', 'c2');
    await until(() => events.filter((e) => e.type === 'turn.completed').length === 2);
    assert.equal(JSON.parse(readFileSync(join(f.cwd, 'unsupported'), 'utf8')).code, -32601);
    await session.send('error', 'c3');
    await until(() => events.filter((e) => e.type === 'turn.completed').length === 3);
    assert.equal(
      events.find((e) => e.type === 'command.accepted' && e.commandId === 'c3'),
      undefined,
    );
    assert.equal(events.at(-1)?.status, 'failed');
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('malformed ACP completion closes its process without manufacturing success', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await grokNativeAdapter.start(f, (event) => events.push(event));
  try {
    await session.send('malformed', 'c1');
    await until(() => events.some((e) => e.type === 'session.closed'));
    assert.equal(
      events.some((e) => e.type === 'turn.completed' && e.status === 'completed'),
      false,
    );
    assert.equal(events.at(-1)?.data?.processStopped, true);
    assert.equal(events.at(-1)?.status, 'failed');
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('Cursor question labels map to native IDs and plan approval stays explicit', () => {
  const request = cursorRequest('cursor/ask_question', {
    questions: [
      {
        id: 'q1',
        prompt: 'Choose',
        options: [
          { id: 'wire-red', label: 'Red' },
          { id: 'wire-blue', label: 'Blue' },
        ],
      },
    ],
  })!;
  assert.deepEqual(request.response({ answers: { q1: ['Red'] } }), {
    outcome: {
      outcome: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: ['wire-red'] }],
    },
  });
  assert.throws(() => request.response({ answers: { q1: ['unknown'] } }), /Unknown/);
  assert.throws(() => request.response({ answers: { q1: ['Red', 'Blue'] } }), /valid selection/);
  assert.deepEqual(
    cursorRequest('cursor/create_plan', { plan: 'Plan' })!.response({ decision: 'deny' }),
    { outcome: { outcome: 'rejected' } },
  );
  const permission = acpPermission({
    toolCall: { title: 'Action' },
    options: [{ kind: 'allow_always', optionId: 'all' }],
  });
  assert.throws(() => permission.response({ decision: 'approve' }), /one-time/);
  assert.deepEqual(permission.response({ decision: 'deny' }), {
    outcome: { outcome: 'cancelled' },
  });
});

test('ACP permission updates can omit previously streamed tool fields', () => {
  const request = acpPermission(
    { toolCall: { toolCallId: 'existing' }, options: [{ optionId: 'one', kind: 'allow_once' }] },
    { name: 'Existing tool', input: { command: 'fixture' } },
  );
  assert.equal(request.event.request?.title, 'Existing tool');
  assert.deepEqual(request.event.request?.tool?.input, { command: 'fixture' });
  assert.deepEqual(request.response({ decision: 'approve' }), {
    outcome: { outcome: 'selected', optionId: 'one' },
  });
});

for (const runner of ['cursor', 'grok']) {
  test(`${runner} native registration binds worker leases and refuses unproven modes`, async () => {
    const { NativeSessionManager } = await import('./manager.js');
    const { randomUUID } = await import('node:crypto');
    const f = setup();
    const manager = new NativeSessionManager(join(f.cwd, 'state'));
    let workerId: string | undefined;
    try {
      const leaseId = randomUUID();
      const worker = await manager.ensure(
        'owner',
        { runner, cwd: f.cwd, sessionId: randomUUID() },
        {
          leaseId,
          executable: f.executable,
          environment: { set: {}, unset: [] },
          safetyTier: 'sandboxed',
        },
      );
      workerId = worker.id;
      assert.equal(worker.workerLeaseId, leaseId);
      assert.equal(worker.ownerPrincipalId, 'owner');
      await assert.rejects(
        manager.create('owner', { runner, cwd: f.cwd, mode: 'plan' }),
        /does not support/,
      );
      const adapter = runner === 'cursor' ? cursorNativeAdapter : grokNativeAdapter;
      assert.equal(adapter.capabilities.questions, false);
    } finally {
      if (workerId) await manager.close('owner', workerId);
      f.cleanup();
    }
  });
}

for (const [runner, variable, binary] of [
  ['cursor', 'CURSOR_CONFIG_DIR', 'cursor-agent'],
  ['grok', 'GROK_HOME', 'grok'],
]) {
  test(`${runner} standalone recovery refuses a changed profile location`, async () => {
    const { NativeSessionManager } = await import('./manager.js');
    const f = setup();
    const oldPath = process.env.PATH;
    const oldProfile = process.env[variable!];
    const manager = new NativeSessionManager(join(f.cwd, 'state'));
    let id: string | undefined;
    try {
      writeFileSync(join(f.cwd, binary!), fixture, { mode: 0o700 });
      process.env.PATH = `${f.cwd}:${oldPath}`;
      process.env[variable!] = join(f.cwd, 'profile-a');
      const session = await manager.create('owner', { runner: runner!, cwd: f.cwd });
      id = session.id;
      await manager.close('owner', id);
      process.env[variable!] = join(f.cwd, 'profile-b');
      await assert.rejects(
        manager.create('owner', {
          runner: runner!,
          cwd: f.cwd,
          resumeSessionId: session.nativeSessionId,
        }),
        /preserve the native account execution context/,
      );
      process.env[variable!] = join(f.cwd, 'profile-a');
      const resumed = await manager.create('owner', {
        runner: runner!,
        cwd: f.cwd,
        resumeSessionId: session.nativeSessionId,
      });
      assert.equal(resumed.nativeSessionId, session.nativeSessionId);
    } finally {
      if (id) await manager.close('owner', id);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldProfile === undefined) delete process.env[variable!];
      else process.env[variable!] = oldProfile;
      f.cleanup();
    }
  });
}
