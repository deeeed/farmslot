import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  type NativeCommandReceipt,
  type NativeSessionEvent,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type PipelineVisualJudgments,
} from '@farmslot/protocol';

import { claudeNativeAdapter } from './claude.js';
import { NativeSessionManager } from './manager.js';
import type { NativeAdapterSession } from './types.js';

const digest = 'sha256:' + 'a'.repeat(64);
const result: PipelineVisualJudgments = {
  schemaVersion: 1,
  recipeRunId: 'recording',
  closureIdentity: digest,
  judgments: [
    {
      claimId: 'ac1',
      verdict: 'confirmed',
      reason: 'The chart price matches the panel.',
      reviewedFiles: [{ path: 'stills/price.png', digest }],
      moments: [],
    },
  ],
};

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'native fixture did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Protocol fixtures only. Production qualification uses the native result live scenario.
const script = `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')) {console.log('codex-cli 0.154.0');process.exit(0)}
fs.writeFileSync('argv',JSON.stringify(process.argv.slice(2)));
const payload=${JSON.stringify(result)};
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const sid=process.argv[process.argv.indexOf('--session-id')+1];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'review-conversation'}}});
 if(m.method==='turn/start'){
  fs.appendFileSync('requests',JSON.stringify(m.params)+'\\n');
  const turn='turn-'+m.id,text=m.params.input[0].text;
  send({id:m.id,result:{turn:{id:turn}}});
  send({method:'turn/started',params:{turn:{id:turn}}});
  send({method:'item/agentMessage/delta',params:{itemId:'stream',delta:JSON.stringify(payload)}});
  if(text!=='stream-only')send({method:'item/completed',params:{item:{id:'final',type:'agentMessage',phase:text==='commentary'?'commentary':'final_answer',text:text==='prose'?'APPROVE':JSON.stringify(payload)}}});
  send({method:'turn/completed',params:{turn:{id:turn,status:'completed'}}});
 }
 if(m.type==='control_request')send({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{}}});
 if(m.type==='user'){
  send({...m,session_id:sid});
  send({type:'assistant',session_id:sid,message:{content:[]}});
  send({type:'result',session_id:sid,subtype:'success',is_error:false,result:JSON.stringify(payload),...(m.message.content==='structured'?{structured_output:payload}:{})});
 }
});
`;

test('schema-bound native command results survive journal reads without accepting streamed or ordinary text', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-result-'));
  const originalPath = process.env.PATH;
  const manager = new NativeSessionManager(join(cwd, 'state'));
  let id: string | undefined;
  t.after(async () => {
    if (id) await manager.close('owner', id);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'codex'), script);
  await chmod(join(cwd, 'codex'), 0o700);
  process.env.PATH = cwd + delimiter + originalPath;
  const session = await manager.create('owner', {
    runner: 'codex',
    cwd,
    resultSchema: PIPELINE_VISUAL_RESULT_SCHEMA,
  });
  id = session.id;
  assert.ok(session.capabilities.structuredResultSchemas?.includes(PIPELINE_VISUAL_RESULT_SCHEMA));
  for (const command of ['structured', 'stream-only', 'commentary', 'prose']) {
    await manager.send('owner', id, command, command);
    await until(() =>
      manager
        .read('owner', id!)
        .commands.some((r) => r.commandId === command && r.state === 'completed'),
    );
    const receipt: NativeCommandReceipt | undefined = manager
      .read('owner', id)
      .commands.find((r) => r.commandId === command);
    assert.ok(receipt);
    assert.equal(Boolean(receipt.structuredResult), command === 'structured', command);
  }
  const request = JSON.parse((await readFile(join(cwd, 'requests'), 'utf8')).split('\n')[0]);
  assert.equal(request.outputSchema.additionalProperties, false);
  await manager.close('owner', id);
  const unbound = await manager.create('owner', { runner: 'codex', cwd });
  id = unbound.id;
  await manager.send('owner', id, 'unbound', 'structured');
  await until(() =>
    manager
      .read('owner', id!)
      .commands.some((r) => r.commandId === 'unbound' && r.state === 'completed'),
  );
  assert.equal(manager.read('owner', id).commands[0]?.structuredResult, undefined);
  await manager.close('owner', id);
  const retained = new NativeSessionManager(join(cwd, 'state')).read('owner', session.id);
  assert.deepEqual(
    retained.commands.find((r) => r.commandId === 'structured')?.structuredResult?.value,
    result,
  );
  assert.equal(retained.session.resultSchema, PIPELINE_VISUAL_RESULT_SCHEMA);
});

test('provider structured_output is accepted while a result prose field stays unqualified', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-result-provider-'));
  const executable = join(cwd, 'runner');
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  const events: NativeSessionEvent[] = [];
  let session: NativeAdapterSession | undefined;
  t.after(async () => {
    await session?.close();
    await rm(cwd, { recursive: true, force: true });
  });
  session = await claudeNativeAdapter.start(
    { cwd, executable, resultSchema: PIPELINE_VISUAL_RESULT_SCHEMA },
    (event) =>
      events.push({
        ...event,
        sessionId: 'session',
        generation: 'generation',
        sequence: events.length + 1,
        at: '2026-10-16T00:00:00Z',
      }),
  );
  assert.ok(JSON.parse(await readFile(join(cwd, 'argv'), 'utf8')).includes('--json-schema'));
  await session.send('structured', 'first');
  await until(() => events.some((e) => e.commandId === 'first' && e.type === 'turn.completed'));
  assert.deepEqual(
    events.find((e) => e.commandId === 'first' && e.type === 'turn.completed')?.structuredResult
      ?.value,
    result,
  );
  await session.send('prose', 'second');
  await until(() => events.some((e) => e.commandId === 'second' && e.type === 'turn.completed'));
  assert.equal(
    events.find((e) => e.commandId === 'second' && e.type === 'turn.completed')?.structuredResult,
    undefined,
  );
});
