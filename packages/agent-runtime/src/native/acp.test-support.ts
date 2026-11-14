import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAcpAdapter } from './acp.js';
import { cursorNativeAdapter } from './cursor.js';
import { grokNativeAdapter } from './grok.js';
import { opencodeNativeAdapter } from './opencode.js';
import type { NativeEventInput } from './types.js';

const fixture = `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const fs=require('node:fs');
fs.writeFileSync('claude-background',process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS??'unset');
if(process.env.OPENCODE_PERMISSION!==undefined)fs.writeFileSync('opencode-permission',process.env.OPENCODE_PERMISSION);
let session='fixture-session',prompt,authenticated=process.env.ACP_FIXTURE_EXISTING_LOGIN==='1';
const configOptions=process.env.ACP_FIXTURE_CONFIG?JSON.parse(process.env.ACP_FIXTURE_CONFIG):[{id:'model',currentValue:'specific-model',options:[{value:'specific-model'}]}];
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const update=u=>send({method:'session/update',params:{sessionId:session,update:u}});
const result=(id,value)=>send({id,result:value});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync('wire',line+'\\n');
 if(m.jsonrpc!=='2.0')process.exit(9);
 if(m.method==='initialize')return result(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:process.env.ACP_FIXTURE_EXISTING_LOGIN==='1'?[]:[{id:'cursor_login'},{id:'cached_token'},{id:'opencode-login'}]});
 if(m.method==='authenticate'){authenticated=true;return result(m.id,{})}
 if(m.method==='session/new'||m.method==='session/load'){
  if(!authenticated)process.exit(10);
  if(m.method==='session/load') {session=m.params.sessionId;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REPLAY'}})}
  return result(m.id,{...(m.method==='session/new'?{sessionId:session}:{}),modes:{availableModes:[{id:'default'},{id:'agent'},{id:'plan'}]},configOptions});
 }
 if(m.method==='session/set_config_option'){const option=configOptions.find(x=>x.id===m.params.configId);if(!option)return send({id:m.id,error:{code:-32602,message:'Unknown config'}});if(process.env.ACP_FIXTURE_CONFIRM_MISMATCH!=='1')option.currentValue=m.params.value;return result(m.id,{configOptions});}
 if(m.method==='session/set_model'||m.method==='session/set_mode')return result(m.id,{});
 if(m.method==='session/prompt'){
  prompt=m.id;const text=m.params.prompt[0].text;
  if(text==='malformed')return result(prompt,{});
  if(text==='error')return send({id:prompt,error:{code:-32000,message:'fixture failure'}});
  if(text==='silent')return;
  if(text==='plan'){
   update({sessionUpdate:'plan',entries:[{content:'Inspect',priority:'high',status:'in_progress'},{content:'Report',priority:'low',status:'pending'}]});
   update({sessionUpdate:'plan',entries:[{content:'Inspect',priority:'high',status:'completed'},{content:'Report',priority:'low',status:'completed'}]});
   return result(prompt,{stopReason:'end_turn'});
  }
  if(text==='late-file-diff'){
   update({sessionUpdate:'tool_call',toolCallId:'late-edit',title:'Edit existing file',kind:'edit',status:'in_progress',content:[{type:'diff',path:'/work/existing.txt',oldText:'before\\n',newText:'optimistic\\n'}]});
   update({sessionUpdate:'tool_call_update',toolCallId:'late-edit',status:'completed'});
   update({sessionUpdate:'tool_call_update',toolCallId:'late-edit',content:[{type:'diff',path:'/work/existing.txt',oldText:'whole before\\n',newText:'whole after\\n'}]});
   return result(prompt,{stopReason:'end_turn'});
  }
  if(text==='file-diff'){
   update({sessionUpdate:'tool_call',toolCallId:'edit1',title:'Edit fixture',kind:'edit',status:'in_progress',rawOutput:{written:true},content:[{type:'diff',path:'/work/example.txt',oldText:'before\\n',newText:'after\\n'}]});
   update({sessionUpdate:'tool_call_update',toolCallId:'edit1',status:'completed',rawOutput:{written:true}});
   return result(prompt,{stopReason:'end_turn'});
  }
  if(text==='shell'){
   update({sessionUpdate:'tool_call',toolCallId:'shell1',title:'Run command',kind:'execute',status:'pending',rawInput:{}});
   update({sessionUpdate:'tool_call_update',toolCallId:'shell1',title:'Run npm test',rawInput:{command:'npm test'}});
   update({sessionUpdate:'tool_call_update',toolCallId:'shell1',status:'completed',rawOutput:{exitCode:0,stdout:'ok\\n',stderr:''}});
   return result(prompt,{stopReason:'end_turn'});
  }
  send({method:'session/update',params:{sessionId:'other-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOREIGN'}}}});
  if(text==='permission')return send({id:71,method:'session/request_permission',params:{sessionId:session,toolCall:{title:'Write fixture',rawInput:{path:'fixture'}},options:[{optionId:'allow-once',kind:'allow_once'},{optionId:'deny-once',kind:'reject_once'}]}});
  if(text==='unknown')return send({id:72,method:'fs/read_text_file',params:{path:'/private'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ANSWER'}});
  update({sessionUpdate:'tool_call',toolCallId:'tool1',title:'read fixture',kind:'read',locations:[{path:'/work/fixture'}],status:'in_progress',rawInput:{path:'fixture'}});
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

export const acpAdapters = [
  ['cursor', cursorNativeAdapter],
  ['grok', grokNativeAdapter],
  ['opencode', opencodeNativeAdapter],
] as const;

export function registerReplayIdentity(variant: (typeof acpAdapters)[number]) {
  const [runner, adapter] = variant;
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
      // The completion update omits the kind and locations; the call keeps them.
      for (const type of ['tool.started', 'tool.completed'])
        assert.deepEqual(
          (({ kind, paths }) => ({ kind, paths }))(events.find((e) => e.type === type)!.tool!),
          { kind: 'file-read', paths: ['/work/fixture'] },
        );
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
            call.method === (runner === 'grok' ? 'session/set_model' : 'session/set_config_option'),
        ).params[runner === 'grok' ? 'modelId' : 'value'],
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

export const nativeWorkerRunners = ['cursor', 'grok', 'opencode'];

export function registerNativeWorkerLease(variant: (typeof nativeWorkerRunners)[number]) {
  const runner = variant;
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
      const adapter = {
        cursor: cursorNativeAdapter,
        grok: grokNativeAdapter,
        opencode: opencodeNativeAdapter,
      }[runner]!;
      assert.equal(adapter.capabilities.questions, false);
    } finally {
      if (workerId) await manager.close('owner', workerId);
      f.cleanup();
    }
  });
}

export const profileRecoveryCases = [
  ['cursor', 'CURSOR_CONFIG_DIR', 'cursor-agent'],
  ['grok', 'GROK_HOME', 'grok'],
];

export function registerProfileRecoveryRefusal(variant: (typeof profileRecoveryCases)[number]) {
  const [runner, variable, binary] = variant;
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

export function registerApprovalModeTransfer(variant: (typeof acpAdapters)[number]) {
  const [runner, adapter] = variant;
  test(`${runner} standalone bypass auto-answers tools, then ask restores requests on the same session`, async () => {
    const f = setup();
    const events: NativeEventInput[] = [];
    const session = await adapter.start({ ...f, approvalMode: 'bypass' }, (event) =>
      events.push(event),
    );
    try {
      await session.send('permission', 'bypass');
      await until(() => events.some((e) => e.type === 'turn.completed'));
      assert.equal(
        events.some((e) => e.type === 'approval.requested'),
        false,
      );
      assert.equal(
        JSON.parse(readFileSync(join(f.cwd, 'permission'), 'utf8')).outcome.optionId,
        'allow-once',
      );
      const automatic = events.find((event) => event.type === 'approval.resolved');
      assert.equal(automatic?.data?.decision, 'approve');
      assert.equal(automatic?.data?.automatic, true);
      assert.equal(automatic?.data?.approvalMode, 'bypass');
      assert.equal(automatic?.request?.title, 'Write fixture');
      assert.equal(automatic?.commandId, 'bypass');
      await session.setApprovalMode!('ask');
      events.length = 0;
      await session.send('permission', 'ask');
      await until(() => events.some((e) => e.type === 'approval.requested'));
      assert.equal(
        events.some((e) => e.type === 'turn.completed'),
        false,
      );
      await session.respond(events.find((e) => e.type === 'approval.requested')!.nativeId!, {
        decision: 'deny',
      });
      await until(() => events.some((e) => e.type === 'turn.completed'));
      assert.equal(
        JSON.parse(readFileSync(join(f.cwd, 'permission'), 'utf8')).outcome.optionId,
        'deny-once',
      );
    } finally {
      await session.close();
      f.cleanup();
    }
  });
}

export const refusedConfigurationCases = [
  'unsupported-model',
  'unsupported-effort',
  'confirmation-mismatch',
] as const;

export function registerConfigurationRefusal(variant: (typeof refusedConfigurationCases)[number]) {
  const scenario = variant;
  test(`ACP rejects ${scenario} before starting a prompt`, async (t) => {
    const f = setup();
    t.after(f.cleanup);
    const adapter = createAcpAdapter({ args: () => [], modes: ['default'], effortConfig: true });
    await assert.rejects(
      adapter
        .start(
          {
            ...f,
            model: scenario === 'unsupported-model' ? 'unlisted' : 'haiku',
            effort: scenario === 'unsupported-effort' ? 'unlisted' : 'low',
            env: {
              ...process.env,
              ACP_FIXTURE_EXISTING_LOGIN: '1',
              ACP_FIXTURE_CONFIRM_MISMATCH: scenario === 'confirmation-mismatch' ? '1' : '0',
              ACP_FIXTURE_CONFIG: JSON.stringify([
                {
                  id: 'model',
                  category: 'model',
                  currentValue: 'opus',
                  options: [{ value: 'haiku' }, { value: 'opus' }],
                },
                {
                  id: 'effort',
                  category: 'thought_level',
                  currentValue: 'high',
                  options: [{ value: 'low' }, { value: 'high' }],
                },
              ]),
            },
          },
          () => {},
        )
        .then(async (session) => {
          await session.close();
        }),
      /did not (advertise|confirm)/,
    );
    assert(!readFileSync(join(f.cwd, 'wire'), 'utf8').includes('session/prompt'));
  });
}

export { fixture, setup, until };
