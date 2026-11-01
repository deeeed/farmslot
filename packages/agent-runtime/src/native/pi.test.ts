import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { observePiAccount, piAccountState } from './account-pi.js';
import { piNativeAdapter } from './pi.js';
import type { NativeEventInput } from './types.js';

// Records shaped like Pi 1.4.0's `--mode rpc` output, as observed live.
const fixture = `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('1.4.0'); process.exit(0); }
const fs=require('node:fs');
fs.writeFileSync('argv',JSON.stringify(process.argv.slice(2)));
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]};
const [provider,id]=(arg('--model')||'fixture/default').split('/');
const session=arg('--session')||'pi-session';
let waiting;
const send=r=>process.stdout.write(JSON.stringify(r)+'\\n');
const reply=(m,data)=>send({id:m.id,type:'response',command:m.type,success:true,...(data?{data}:{})});
const settle=(aborted=false)=>send({type:'agent_settled',aborted});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 if(!line.trim())return;
 const m=JSON.parse(line);fs.appendFileSync('wire',line+'\\n');
 if(m.type==='get_state')return reply(m,{sessionId:session,model:{provider,id},isStreaming:false});
 if(m.type==='get_available_models')return reply(m,{models:process.env.PI_FIXTURE_NO_MODELS?[]:[{provider,id}]});
 if(m.type==='clear_queue')return reply(m,{steering:[],followUp:[]});
 if(m.type==='abort'){settle(true);return reply(m)}
 if(m.type==='steer')return reply(m,{disposition:'queued'});
 if(m.type==='extension_ui_response'){fs.writeFileSync('dialog',line);return settle()}
 if(m.type!=='prompt')return;
 const text=m.message;
 if(text==='reject'){send({type:'queue_update',steering:[],followUp:[]});return send({id:m.id,type:'response',command:'prompt',success:false,error:'busy'})}
 if(text==='handled')return reply(m,{disposition:'handled'});
 if(text==='events-first'){send({type:'agent_start'});reply(m,{disposition:'started'});return settle()}
 reply(m,{disposition:'started'});
 send({type:'agent_start'});
 if(text==='wait')return;
 if(text==='dialog')return send({type:'extension_ui_request',id:'ui1',method:'confirm',title:'Allow?'});
 if(text==='error'){send({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'quota exceeded'}});return settle()}
 if(text==='retry'){
  send({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'529 overloaded'}});
  send({type:'agent_end',messages:[],willRetry:true});
  send({type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:10,errorMessage:'529 overloaded'});
  send({type:'agent_start'});
  send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}],stopReason:'stop'}});
  send({type:'auto_retry_end',success:true,attempt:1});
  return settle();
 }
 send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'ANSWER'}});
 send({type:'tool_execution_start',toolCallId:'t1',toolName:'bash',args:{command:'npm test'}});
 send({type:'tool_execution_end',toolCallId:'t1',toolName:'bash',result:{content:[{type:'text',text:'ok'}]},isError:false});
 send({type:'tool_execution_start',toolCallId:'t2',toolName:'read',args:{path:'src/a.ts'}});
 send({type:'tool_execution_end',toolCallId:'t2',toolName:'read',result:{content:[]},isError:true});
 settle();
});`;

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Pi fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'farmslot-pi-'));
  const executable = join(cwd, 'pi');
  writeFileSync(executable, fixture);
  chmodSync(executable, 0o700);
  return { cwd, executable, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
const wire = (cwd: string) =>
  readFileSync(join(cwd, 'wire'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test('a Pi turn streams text and tools and completes when Pi settles', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await piNativeAdapter.start(
    { ...f, model: 'litellm/flash', effort: 'high' },
    (event) => events.push(event),
  );
  try {
    assert.equal(session.nativeSessionId, 'pi-session');
    assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, 'argv'), 'utf8')), [
      '--mode',
      'rpc',
      '--model',
      'litellm/flash',
      '--thinking',
      'high',
    ]);
    await session.send('text', 'c1');
    await until(() => events.some((e) => e.type === 'turn.completed'));
    assert.deepEqual(
      events.filter((e) => e.commandId === 'c1').map((e) => e.type),
      [
        'command.accepted',
        'turn.started',
        'text.delta',
        'tool.started',
        'tool.completed',
        'tool.started',
        'tool.completed',
        'turn.completed',
      ],
    );
    assert.equal(events.find((e) => e.type === 'text.delta')?.text, 'ANSWER');
    const tools = events.filter((e) => e.type === 'tool.completed').map((e) => e.tool!);
    assert.deepEqual(
      tools.map(({ kind, command, paths, status }) => ({ kind, command, paths, status })),
      [
        { kind: 'command', command: 'npm test', paths: undefined, status: 'completed' },
        { kind: 'file-read', command: undefined, paths: ['src/a.ts'], status: 'failed' },
      ],
    );
    assert.equal(events.find((e) => e.type === 'turn.completed')?.status, 'completed');
  } finally {
    await session.close();
    f.cleanup();
  }
  assert.equal(events.at(-1)?.type, 'session.closed');
  assert.equal(events.at(-1)?.data?.processStopped, true);
});

// The fixture always reports `fixture/default`, whatever was requested.
const fixedModel = () =>
  fixture.replace("(arg('--model')||'fixture/default')", "'fixture/default'");

test('Pi refuses a model other than the one requested', async () => {
  const f = setup();
  try {
    writeFileSync(f.executable, fixedModel());
    await assert.rejects(
      piNativeAdapter.start({ ...f, model: 'litellm/flash' }, () => undefined),
      /Pi model is unavailable: litellm\/flash/,
    );
  } finally {
    f.cleanup();
  }
});

test('a bare Pi model ID matches the model Pi selected for it', async () => {
  const f = setup();
  try {
    writeFileSync(f.executable, fixedModel());
    await assert.rejects(
      piNativeAdapter.start({ ...f, model: 'flash' }, () => undefined),
      /Pi model is unavailable: flash/,
    );
    // A bare ID matches the model Pi selected for it; a `:<thinking>` suffix sets the level.
    const session = await piNativeAdapter.start({ ...f, model: 'default:high' }, () => undefined);
    await session.close();
  } finally {
    f.cleanup();
  }
});

test('Pi resumes only the exact saved session', async () => {
  const f = setup();
  const session = await piNativeAdapter.start(
    { ...f, resumeSessionId: 'saved-1' },
    () => undefined,
  );
  try {
    assert.equal(session.nativeSessionId, 'saved-1');
    assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, 'argv'), 'utf8')).slice(-2), [
      '--session',
      'saved-1',
    ]);
  } finally {
    await session.close();
  }
  try {
    writeFileSync(f.executable, fixture.replace("arg('--session')||", ''));
    await assert.rejects(
      piNativeAdapter.start({ ...f, resumeSessionId: 'saved-1' }, () => undefined),
      /Pi loaded a different native session/,
    );
  } finally {
    f.cleanup();
  }
});

test('Pi interrupts, steers and fails turns from its own records', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await piNativeAdapter.start(f, (event) => events.push(event));
  const completed = () => events.filter((e) => e.type === 'turn.completed');
  try {
    await assert.rejects(session.steer!('later', 's0'), /no running turn/);
    await session.send('wait', 'c1');
    await assert.rejects(session.send('again', 'c2'), /still active/);
    await session.steer!('look here', 's1');
    assert.equal(
      events.find((e) => e.commandId === 's1' && e.type === 'command.accepted')?.turnId,
      events.find((e) => e.commandId === 'c1' && e.type === 'command.accepted')?.turnId,
    );
    await session.interrupt();
    await until(() => completed().length === 1);
    assert.equal(completed()[0].status, 'interrupted');

    // Stop clears the steer Pi still holds, so it cannot run in a later turn.
    assert.deepEqual(
      wire(f.cwd)
        .map(({ type }) => type)
        .filter((type) => type === 'steer' || type === 'clear_queue' || type === 'abort'),
      ['steer', 'clear_queue', 'abort'],
    );

    await session.send('error', 'c3');
    await until(() => completed().length === 2);
    assert.equal(completed()[1].status, 'failed');
    assert.deepEqual(
      events.filter((e) => e.type === 'error').map((e) => e.text),
      ['quota exceeded'],
    );

    // A failed attempt that Pi retried successfully completes the turn.
    await session.send('retry', 'c3b');
    await until(() => completed().length === 3);
    assert.equal(completed()[2].status, 'completed');
    assert.equal(events.filter((e) => e.type === 'error').length, 1);

    // An event before the prompt reply still accepts the command first.
    await session.send('events-first', 'c4');
    await until(() => completed().length === 4);
    assert.deepEqual(
      events.filter((e) => e.commandId === 'c4').map((e) => e.type),
      ['command.accepted', 'turn.started', 'turn.completed'],
    );

    await session.send('handled', 'c5');
    assert.equal(completed()[4].status, 'completed');
    // A queue notice before a refused prompt does not accept it.
    await assert.rejects(session.send('reject', 'c6'), /Pi prompt failed: busy/);
    assert.equal(events.filter((e) => e.commandId === 'c6').length, 0);
    await session.send('dialog', 'c7');
    await until(() => completed().length === 6);
    assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, 'dialog'), 'utf8')), {
      type: 'extension_ui_response',
      id: 'ui1',
      cancelled: true,
    });
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('Pi account state reads its RPC model list', async (t) => {
  const listing = (models: unknown) => ({ type: 'response', success: true, data: { models } });
  assert.equal(
    piAccountState(listing([{ provider: 'litellm', id: 'flash' }])).login,
    'authenticated',
  );
  assert.equal(piAccountState(listing([])).login, 'signed-out');
  assert.throws(() => piAccountState({ type: 'response', success: false, error: 'x' }));
  const f = setup();
  t.after(f.cleanup);
  for (const [env, login] of [
    [{}, 'authenticated'],
    [{ PI_FIXTURE_NO_MODELS: '1' }, 'signed-out'],
  ] as const) {
    const observed = await observePiAccount({
      cwd: f.cwd,
      executable: f.executable,
      env: { ...process.env, ...env },
    });
    assert.equal(observed.login, login);
    assert.equal(observed.version, '1.4.0');
  }
});
