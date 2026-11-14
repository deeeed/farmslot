import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { claudeNativeAdapter } from '@farmslot/agent-runtime/native/claude';
import { NativeSessionManager } from '@farmslot/agent-runtime/native/manager';
import type { NativeContextCompactionRequest } from '@farmslot/protocol';

const protocolFixture = `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('2.1.322');process.exit(0);}
const fs=require('node:fs'),readline=require('node:readline');
const flag=process.argv.includes('--resume')?'--resume':'--session-id';
const session=process.argv[process.argv.indexOf(flag)+1];
const send=m=>process.stdout.write(JSON.stringify({...m,session_id:m.session_id??session})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request'&&m.request.subtype==='initialize'){
  send({type:'system',subtype:'init'});send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});return;
 }
 if(m.type!=='user')return;
 if(m.message.content.startsWith('/compact ')){
  fs.appendFileSync(process.env.COMPACT_LOG,'compact\\n');
  if(process.env.COMPACT_MODE==='hold')return;
  if(process.env.COMPACT_MODE!=='no-boundary')send({type:'system',subtype:'compact_boundary',uuid:'manual-boundary',session_id:process.env.COMPACT_MODE==='foreign'?'another-session':session,compact_metadata:{trigger:'manual',pre_tokens:100,post_tokens:20,duration_ms:10}});
  setTimeout(()=>send({type:'result',subtype:'success',is_error:false}),20);return;
 }
 send({type:'user',message:m.message});send({type:'assistant',message:{content:[{type:'text',text:'done'}]}});send({type:'result',subtype:'success',is_error:false});
});
`;

async function fixture(t: TestContext, mode = '') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-compact-'));
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  const executable = path.join(directory, 'runner');
  const log = path.join(directory, 'compactions.log');
  await writeFile(executable, protocolFixture, { mode: 0o755 });
  const environment = { COMPACT_LOG: log, COMPACT_MODE: mode };
  return { directory, executable, log, environment, cleanup };
}

test('structured manual boundary completes maintenance without accepting or ending a task turn', async (t) => {
  const f = await fixture(t);
  const events: Array<{ type: string }> = [];
  const adapter = await claudeNativeAdapter.start(
    { cwd: f.directory, executable: f.executable, env: { ...process.env, ...f.environment } },
    (event) => events.push(event),
  );
  f.cleanup.push(() => adapter.close());
  assert(adapter.compact);
  const evidence = await adapter.compact('Keep findings, retire old task commands');
  assert.equal(evidence.nativeSessionId, adapter.nativeSessionId);
  assert.equal(evidence.boundaryId, 'manual-boundary');
  assert.equal(evidence.preTokens, 100);
  assert.equal(evidence.postTokens, 20);
  assert(
    !events.some((e) => ['turn.started', 'turn.completed', 'command.accepted'].includes(e.type)),
  );
});

for (const mode of ['foreign', 'no-boundary']) {
  test(`compaction refuses ${mode} evidence`, async (t) => {
    const f = await fixture(t, mode);
    const adapter = await claudeNativeAdapter.start(
      { cwd: f.directory, executable: f.executable, env: { ...process.env, ...f.environment } },
      () => {},
    );
    f.cleanup.push(() => adapter.close());
    assert(adapter.compact);
    await assert.rejects(
      adapter.compact('Preserve the exact session'),
      /session|boundary|identity/i,
    );
  });
}

async function worker(t: TestContext, mode = '') {
  const f = await fixture(t, mode);
  const manager = new NativeSessionManager(path.join(f.directory, 'sessions'));
  const leaseId = 'owned-lease';
  const launch = {
    leaseId,
    executable: f.executable,
    environment: { set: f.environment, unset: [] },
    safetyTier: 'dangerous' as const,
  };
  const session = await manager.create(
    'owner',
    { runner: 'claude', model: 'claude-opus-5-5', cwd: f.directory },
    launch,
  );
  f.cleanup.push(() => manager.close('owner', session.id));
  assert(session.nativeSessionId);
  const request: NativeContextCompactionRequest = {
    operationId: 'compact-once',
    lineageId: 'lineage',
    packetDigest: 'a'.repeat(64),
    nativeSessionId: session.nativeSessionId,
    focus: 'Preserve findings and forget obsolete task commands',
  };
  return { ...f, manager, session, launch, leaseId, request };
}

test('worker intent is durable before send; retries reconcile once under the same session/packet', async (t) => {
  const f = await worker(t);
  const pending = f.manager.compactWorker(
    'owner',
    f.session.id,
    f.session.generation,
    f.leaseId,
    f.request,
  );
  const journal = await readFile(
    path.join(f.directory, 'sessions', f.session.id + '.journal'),
    'utf8',
  );
  const entries = journal
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(
    entries.some((x) =>
      x.info?.contextCompactions?.some((c: { status: string }) => c.status === 'pending'),
    ),
  );
  const reconciled = await f.manager.compactWorker(
    'owner',
    f.session.id,
    f.session.generation,
    f.leaseId,
    f.request,
  );
  assert(['pending', 'confirmed'].includes(reconciled.status));
  const completed = await pending;
  assert.equal(completed.status, 'confirmed');
  assert.deepEqual(
    await f.manager.compactWorker(
      'owner',
      f.session.id,
      f.session.generation,
      f.leaseId,
      f.request,
    ),
    completed,
  );
  assert.equal((await readFile(f.log, 'utf8')).trim(), 'compact');
  assert.equal(f.manager.read('owner', f.session.id).commands.length, 0);
  await assert.rejects(
    f.manager.compactWorker('owner', f.session.id, f.session.generation, f.leaseId, {
      ...f.request,
      packetDigest: 'b'.repeat(64),
    }),
    /identity changed/,
  );
});

test('owner, generation, lease and provider identity remain fenced', async (t) => {
  const f = await worker(t);
  await assert.rejects(
    f.manager.compactWorker('other', f.session.id, f.session.generation, f.leaseId, f.request),
  );
  await assert.rejects(
    f.manager.compactWorker('owner', f.session.id, 'stale-generation', f.leaseId, f.request),
    /generation|lease/,
  );
  await assert.rejects(
    f.manager.compactWorker('owner', f.session.id, f.session.generation, 'stale-lease', f.request),
    /generation|lease/,
  );
  await assert.rejects(
    f.manager.compactWorker('owner', f.session.id, f.session.generation, f.leaseId, {
      ...f.request,
      nativeSessionId: 'foreign',
    }),
    /exact provider session/,
  );
});

test('a stopped-session resume retains confirmed compaction and never repeats the provider command', async (t) => {
  const f = await worker(t);
  const result = await f.manager.compactWorker(
    'owner',
    f.session.id,
    f.session.generation,
    f.leaseId,
    f.request,
  );
  await f.manager.close('owner', f.session.id);
  const resumed = await f.manager.resumeWorker(
    'owner',
    {
      sessionId: f.session.id,
      generation: f.session.generation,
      commandId: 'resume-after-stop',
      resumeSessionId: f.request.nativeSessionId,
      runner: 'claude',
      model: 'claude-opus-5-5',
      cwd: f.directory,
    },
    f.launch,
  );
  assert.equal(resumed.nativeSessionId, f.request.nativeSessionId);
  assert.deepEqual(
    await f.manager.compactWorker('owner', resumed.id, resumed.generation, f.leaseId, f.request),
    result,
  );
  assert.equal((await readFile(f.log, 'utf8')).trim(), 'compact');
});

test('uncertain maintenance blocks task delivery and does not compact again', async (t) => {
  const f = await worker(t, 'no-boundary');
  const result = await f.manager.compactWorker(
    'owner',
    f.session.id,
    f.session.generation,
    f.leaseId,
    f.request,
  );
  assert.equal(result.status, 'unconfirmed');
  await assert.rejects(f.manager.send('owner', f.session.id, 'new-task', 'task'), /unconfirmed/);
  assert.equal(
    (
      await f.manager.compactWorker(
        'owner',
        f.session.id,
        f.session.generation,
        f.leaseId,
        f.request,
      )
    ).status,
    'unconfirmed',
  );
  assert.equal((await readFile(f.log, 'utf8')).trim(), 'compact');
});
