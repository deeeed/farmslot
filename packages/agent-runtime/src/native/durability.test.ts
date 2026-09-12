import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { type HostIdentity, requestHost, socketDirectory } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { alive, appendDurable, matchesProcess, readJson } from './storage.js';

const fixture = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const fs = require('node:fs');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
let thread, turn, timer;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume') {
  thread=m.params.threadId || 'thread-'+process.pid;
  send({id:m.id,result:{thread:{id:thread}}});
 }
 if(m.method==='turn/start') {
  const text=m.params.input[0].text; turn='turn-'+m.id;
  fs.appendFileSync('inputs',text+'\\n');
  if(text==='unknown') { process.exit(23); }
  send({id:m.id,result:{turn:{id:turn}}});
  send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
  if(text==='approval') {send({id:7,method:'item/commandExecution/requestApproval',params:{threadId:thread,command:'fixture tool'}});return;}
  send({method:'item/started',params:{threadId:thread,item:{id:'tool',type:'commandExecution',command:'fixture tool'}}});
  const child = require('node:child_process').spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});
  fs.writeFileSync('descendant',String(child.pid));
  timer=setTimeout(()=>{
   child.kill(); fs.appendFileSync('effects',text+'\\n');
   for(let i=0;i<300;i++) send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'text',delta:'x'}});
   send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
  },600);
 }
 if(m.id===7 && !m.method){fs.appendFileSync('decisions',JSON.stringify(m.result)+'\\n');send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}
 if(m.method==='turn/interrupt'){clearTimeout(timer);send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'interrupted'}}});}
});`;
const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Test condition timed out');
    await delay();
  }
}
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'native-durability-'));
  writeFileSync(join(cwd, 'codex'), fixture);
  chmodSync(join(cwd, 'codex'), 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${cwd}${delimiter}${oldPath}`;
  return {
    cwd,
    root: join(cwd, 'state'),
    restore() {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test('recovery and terminal close require confirmed cleanup even when the wrapper is gone', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    await manager.close('owner', session.id);
    const stopped = manager.read('owner', session.id).session;
    assert.equal(stopped.processStopped, true);
    assert.equal(alive(stopped.processPid!), false);
    // Reproduce a durable cleanup failure after the wrapper has exited.
    appendDurable(join(fixture.root, `${session.id}.journal`), {
      info: { ...stopped, state: 'failed', processStopped: false },
    });
    const recovered = new NativeSessionManager(fixture.root);
    await assert.rejects(recovered.close('owner', session.id), /cleanup is unconfirmed/);
    await assert.rejects(
      recovered.create('owner', {
        runner: 'codex',
        cwd: fixture.cwd,
        resumeSessionId: session.nativeSessionId,
      }),
      /cleanup is unconfirmed/,
    );
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});

test('a torn first journal write cannot reserve input ownership or prevent host startup', () => {
  const fixture = setup();
  try {
    mkdirSync(fixture.root, { mode: 0o700 });
    const journal = join(fixture.root, 'unstarted.journal');
    writeFileSync(journal, '{"info":', { mode: 0o600 });
    assert.deepEqual(new NativeSessionManager(fixture.root).list('owner'), []);
    assert.equal(readFileSync(journal, 'utf8'), '');
  } finally {
    fixture.restore();
  }
});

test('linear journal, durable uncertain receipt, exact recovery and stale generation decisions', async () => {
  const fixture = setup();
  const { cwd, root } = fixture;
  let manager = new NativeSessionManager(root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd });
    await manager.send('owner', session.id, 'long', 'long-prompt-marker');
    await until(() => manager.read('owner', session.id).session.state === 'idle');
    const journal = readFileSync(join(root, `${session.id}.journal`), 'utf8');
    assert.ok(
      journal
        .trim()
        .split('\n')
        .every((line) => Object.keys(JSON.parse(line)).length > 0),
    );
    assert.ok(
      journal.split('long-prompt-marker').length < 10,
      'Stream events repeated prompt history',
    );
    const page = manager.read('owner', session.id, 0, 17);
    assert.equal(page.events.length, 17);
    assert.equal(page.cursor, 17);
    assert.equal(page.hasMore, true);
    assert.throws(() => manager.read('owner', session.id, 0, 501), /limit/);
    assert.equal(manager.read('owner', session.id, 17, 17).events[0]?.sequence, 18);
    await manager.send('owner', session.id, 'pending-approval', 'approval');
    await until(() => manager.read('owner', session.id).pendingRequests.length === 1);
    const request = manager.read('owner', session.id).pendingRequests[0]!;
    assert.notEqual(request.request!.id, request.nativeId);
    await assert.rejects(
      manager.respond('other', session.id, request.request!.id, { decision: 'approve' }),
      /not found/,
    );
    await assert.rejects(
      manager.respond('owner', session.id, request.nativeId!, { decision: 'approve' }),
      /stale/,
    );
    await manager.close('owner', session.id);
    assert.equal(manager.read('owner', session.id).session.processStopped, true);
    assert.equal(
      matchesProcess(process.pid, manager.read('owner', session.id).session.processIdentity!),
      false,
    );
    manager = new NativeSessionManager(root);
    const resumed = await manager.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.equal(resumed.id, session.id);
    assert.notEqual(resumed.generation, session.generation);
    assert.equal(
      (await manager.send('owner', session.id, 'long', 'long-prompt-marker')).state,
      'completed',
    );
    await manager.send('owner', session.id, 'new-approval', 'approval');
    await until(() => manager.read('owner', session.id).pendingRequests.length === 1);
    await assert.rejects(
      manager.respond('owner', session.id, request.request!.id, { decision: 'approve' }),
      /stale/,
    );
    const current = manager.read('owner', session.id).pendingRequests[0]!;
    await manager.respond('owner', session.id, current.request!.id, { decision: 'deny' });
    await until(() => manager.read('owner', session.id).session.state === 'idle');
    await assert.rejects(
      manager.send('owner', session.id, 'uncertain', 'unknown'),
      /exited|closed/,
    );
    await until(() => manager.read('owner', session.id).session.state === 'failed');
    manager = new NativeSessionManager(root);
    assert.equal(
      (await manager.send('owner', session.id, 'uncertain', 'unknown')).state,
      'unknown',
    );
    await manager.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.equal(
      (await manager.send('owner', session.id, 'uncertain', 'unknown')).state,
      'unknown',
    );
    assert.equal(
      readFileSync(join(cwd, 'inputs'), 'utf8')
        .split('\n')
        .filter((line) => line === 'unknown').length,
      1,
    );
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});

test('local host survives caller exit, authenticates IPC, replays once and cleans host-crash descendants', async () => {
  const fixture = setup();
  const { cwd, root } = fixture;
  const client = new NativeSessionClient(root);
  try {
    // Two independent clients race the first daemon launch.
    assert.deepEqual(
      await Promise.all([client.list('owner'), new NativeSessionClient(root).list('owner')]),
      [[], []],
    );
    const host = readJson<HostIdentity>(join(root, 'host.json'));
    assert.ok(Buffer.byteLength(host.socket) < 104);
    assert.equal(statSync(host.socket).mode & 0o777, 0o600);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    await assert.rejects(
      requestHost({ ...host, token: '0'.repeat(64) }, { method: 'list', owner: 'owner' }),
      /authentication/,
    );
    const callerFile = join(cwd, 'caller.mjs');
    const clientUrl = new URL(
      `./client.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
      import.meta.url,
    ).href;
    writeFileSync(
      callerFile,
      `import {NativeSessionClient} from ${JSON.stringify(clientUrl)}; const c=new NativeSessionClient(${JSON.stringify(root)});const s=await c.create('owner',{runner:'codex',cwd:${JSON.stringify(cwd)}});await c.send('owner',s.id,'once','side-effect');console.log(JSON.stringify(s));`,
    );
    const caller = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), callerFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    caller.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    caller.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(caller, 'exit');
    assert.equal(code, 0, stderr);
    const session = JSON.parse(output) as {
      id: string;
      nativeSessionId: string;
      hostPid: number;
      processPid: number;
    };
    assert.ok(alive(session.processPid));
    assert.equal(existsSync(join(cwd, 'effects')), false, 'Task completed before caller exit');
    await until(() => existsSync(join(cwd, 'effects')));
    await until(async () => (await client.read('owner', session.id)).session.state === 'idle');
    const reconnected = new NativeSessionClient(root);
    const replay = [];
    let cursor = 0;
    let more = true;
    while (more) {
      const page = await reconnected.read('owner', session.id, cursor, 23);
      replay.push(...page.events);
      cursor = page.cursor;
      more = page.hasMore;
    }
    assert.equal(new Set(replay.map((event) => event.sequence)).size, replay.length);
    assert.equal((await reconnected.read('owner', session.id, cursor)).events.length, 0);
    assert.equal((await reconnected.read('owner', session.id)).session.hostPid, session.hostPid);
    await reconnected.send('owner', session.id, 'once', 'side-effect');
    assert.equal(readFileSync(join(cwd, 'effects'), 'utf8'), 'side-effect\n');
    await reconnected.send('owner', session.id, 'approval', 'approval');
    await until(async () => (await client.read('owner', session.id)).pendingRequests.length === 1);
    const secondCwd = join(cwd, 'second');
    mkdirSync(secondCwd);
    const second = await client.create('owner', { runner: 'codex', cwd: secondCwd });
    assert.notEqual(second.nativeSessionId, session.nativeSessionId);
    const pending = (await new NativeSessionClient(root).read('owner', session.id))
      .pendingRequests[0]!;
    await assert.rejects(
      client.respond('other', session.id, pending.request!.id, { decision: 'approve' }),
      /not found/,
    );
    await assert.rejects(
      client.respond('owner', second.id, pending.request!.id, { decision: 'approve' }),
      /stale/,
    );
    await client.close('owner', second.id);
    assert.ok(alive(session.processPid));
    await reconnected.respond('owner', session.id, pending.request!.id, { decision: 'deny' });
    await until(async () => (await client.read('owner', session.id)).session.state === 'idle');
    rmSync(join(cwd, 'descendant'));
    await reconnected.send('owner', session.id, 'crash', 'crash');
    await until(() => existsSync(join(cwd, 'descendant')));
    const descendant = Number(readFileSync(join(cwd, 'descendant'), 'utf8'));
    // Freeze the only journal writer to reproduce a crash midway through its last append.
    process.kill(session.hostPid, 'SIGSTOP');
    appendFileSync(join(root, 'sessions', `${session.id}.journal`), '{"event":');
    process.kill(session.hostPid, 'SIGKILL');
    await until(() => !alive(session.processPid) && !alive(descendant) && !alive(host.pid));
    const failed = await new NativeSessionClient(root).read('owner', session.id);
    assert.equal(failed.session.state, 'failed');
    assert.ok(failed.session.recovery);
    assert.ok(
      !failed.events.some(
        (event) => event.commandId === 'crash' && event.type === 'turn.completed',
      ),
    );
    const resumed = await client.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.equal(resumed.nativeSessionId, session.nativeSessionId);
    assert.equal((await client.send('owner', session.id, 'crash', 'crash')).state, 'accepted');
    assert.equal(
      readFileSync(join(cwd, 'inputs'), 'utf8')
        .split('\n')
        .filter((line) => line === 'crash').length,
      1,
    );
    await client.close('owner', session.id);
  } catch (error) {
    const log = join(root, 'host.log');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${existsSync(log) ? readFileSync(log, 'utf8') : ''}`,
      { cause: error },
    );
  } finally {
    const path = join(root, 'host.json');
    if (existsSync(path)) {
      const host = readJson<HostIdentity>(path);
      if (alive(host.pid)) {
        process.kill(host.pid, 'SIGTERM');
        await until(() => !alive(host.pid));
      }
    }
    // Fixture owns this socket directory, never a production host.
    rmSync(socketDirectory(root), { recursive: true, force: true });
    fixture.restore();
  }
});

test('native auth environment remains inherited but is absent from durable state', async () => {
  const fixture = setup();
  const originalKey = process.env.CODEX_LB_API_KEY;
  const originalMarker = process.env.CLAUDECODE;
  process.env.CODEX_LB_API_KEY = 'fixture-native-route';
  process.env.CLAUDECODE = 'parent-context';
  const executable = join(fixture.cwd, 'codex');
  writeFileSync(
    executable,
    readFileSync(executable, 'utf8').replace(
      "const fs = require('node:fs');",
      "if(process.env.CODEX_LB_API_KEY!=='fixture-native-route'||process.env.CLAUDECODE)process.exit(24);\nconst fs = require('node:fs');",
    ),
  );
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    assert.ok(
      !readFileSync(join(fixture.root, `${session.id}.journal`), 'utf8').includes(
        'fixture-native-route',
      ),
    );
    await manager.close('owner', session.id);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        manager.create('owner', {
          runner: 'codex',
          cwd: fixture.cwd,
          resumeSessionId: session.nativeSessionId,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    if (originalKey === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = originalKey;
    if (originalMarker === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = originalMarker;
    fixture.restore();
  }
});

test('native host storage follows FARMSLOT_HOME and its explicit override', () => {
  const home = process.env.FARMSLOT_HOME;
  const override = process.env.FARMSLOT_NATIVE_STATE_DIR;
  try {
    process.env.FARMSLOT_HOME = '/tmp/native-instance-home';
    delete process.env.FARMSLOT_NATIVE_STATE_DIR;
    assert.equal(new NativeSessionClient().root, '/tmp/native-instance-home/native-sessions');
    process.env.FARMSLOT_NATIVE_STATE_DIR = '/tmp/native-explicit-state';
    assert.equal(new NativeSessionClient().root, '/tmp/native-explicit-state');
  } finally {
    if (home === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = home;
    if (override === undefined) delete process.env.FARMSLOT_NATIVE_STATE_DIR;
    else process.env.FARMSLOT_NATIVE_STATE_DIR = override;
  }
});

test('unregistered host cannot bind and exits if its supervisor disappears', async () => {
  const { fork } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'native-unregistered-host-'));
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const child = fork(fileURLToPath(new URL(`./host.${extension}`, import.meta.url)), [root], {
    execArgv: extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit');
  try {
    await delay(500);
    assert.equal(existsSync(join(root, 'sessions')), false);
    assert.equal(existsSync(join(socketDirectory(root), 's')), false);
    child.disconnect();
    const [code] = await exited;
    assert.notEqual(code, 0);
    assert.match(stderr, /before host registration/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
