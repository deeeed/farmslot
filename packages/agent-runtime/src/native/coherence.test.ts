import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { NativeSessionManager } from './manager.js';

const fixture = `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line);
 if(message.method==='initialize') send({id:message.id,result:{}});
 if(message.method==='thread/start'||message.method==='thread/resume') send({id:message.id,result:{thread:{id:message.params.threadId||'fixture-conversation'}}});
 if(message.method==='turn/start') {
  process.stderr.write('Authorization: Bearer '+process.env.NATIVE_EXIT_TEST_TOKEN+'\\n',()=>process.kill(process.pid,'SIGTERM'));
 }
});`;

test('native crash diagnostics survive journal reload', { timeout: 60_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-coherence-'));
  const root = join(cwd, 'state');
  writeFileSync(join(cwd, 'codex'), fixture);
  chmodSync(join(cwd, 'codex'), 0o700);
  const oldPath = process.env.PATH;
  const oldToken = process.env.NATIVE_EXIT_TEST_TOKEN;
  process.env.PATH = `${cwd}${delimiter}${oldPath}`;
  const secret = 'native-session-fixture-secret';
  process.env.NATIVE_EXIT_TEST_TOKEN = secret;
  const manager = new NativeSessionManager(root);
  let sessionId: string | undefined;
  t.after(async () => {
    if (sessionId) await manager.close('owner', sessionId);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldToken === undefined) delete process.env.NATIVE_EXIT_TEST_TOKEN;
    else process.env.NATIVE_EXIT_TEST_TOKEN = oldToken;
    rmSync(cwd, { recursive: true, force: true });
  });
  const session = await manager.create('owner', { runner: 'codex', cwd });
  sessionId = session.id;
  await assert.rejects(manager.send('owner', session.id, 'crash-command', 'crash'));
  const deadline = Date.now() + 15_000;
  let snapshot = manager.read('owner', session.id).session;
  while (!snapshot.processStopped && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    snapshot = manager.read('owner', session.id).session;
  }
  assert.equal(snapshot.processStopped, true);
  assert.equal(snapshot.exitCode, null);
  assert.equal(snapshot.signal, 'SIGTERM');
  assert.match(snapshot.error ?? '', /Native runner exited/);
  assert.match(snapshot.stderrTail?.join('\n') ?? '', /redacted/i);
  assert.ok(!readFileSync(join(root, `${session.id}.journal`), 'utf8').includes(secret));
  const reloaded = new NativeSessionManager(root).read('owner', session.id).session;
  assert.equal(reloaded.signal, 'SIGTERM');
  assert.deepEqual(reloaded.stderrTail, snapshot.stderrTail);
  appendFileSync(
    join(root, `${session.id}.journal`),
    `${JSON.stringify({ info: { ...snapshot, processStopped: false, processStopReason: undefined, state: 'failed' } })}\n`,
  );
  const reconciled = new NativeSessionManager(root).read('owner', session.id).session;
  assert.equal(reconciled.processStopped, true, 'missing process must be reconciled');
  assert.equal(reconciled.processStopReason, 'process-missing');
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  assert.ok(descendant.pid);
  try {
    const identity = execFileSync('ps', ['-p', String(descendant.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim();
    appendFileSync(
      join(root, `${session.id}.journal`),
      `${JSON.stringify({ info: { ...snapshot, processStopped: false }, processes: [{ pid: descendant.pid, parent: 0, group: descendant.pid, identity }] })}\n`,
    );
    const surviving = new NativeSessionManager(root).read('owner', session.id).session;
    assert.equal(
      surviving.processStopped,
      false,
      'an observed detached descendant must block cleanup confirmation',
    );
  } finally {
    const stopped = once(descendant, 'exit');
    descendant.kill('SIGTERM');
    await stopped;
  }
});

test(
  'busy steering is durable and delivered exactly once after the current turn',
  { timeout: 60_000 },
  async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'native-queue-'));
    const root = join(cwd, 'state');
    const script = fixture.replace(
      "process.stderr.write('Authorization: Bearer '+process.env.NATIVE_EXIT_TEST_TOKEN+'\\n',()=>process.kill(process.pid,'SIGTERM'));",
      `
  const text=message.params.input[0].text;
  require('node:fs').appendFileSync('inputs',text+'\\n');
  const turn='turn-'+message.id;
  send({id:message.id,result:{turn:{id:turn}}});
  send({method:'turn/started',params:{threadId:'fixture-conversation',turn:{id:turn}}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId:'fixture-conversation',turn:{id:turn,status:'completed'}}}),text==='restart-hold'?10000:400);
`,
    );
    writeFileSync(join(cwd, 'codex'), script);
    chmodSync(join(cwd, 'codex'), 0o700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${cwd}${delimiter}${oldPath}`;
    const manager = new NativeSessionManager(root);
    let activeManager = manager;
    const session = await manager.create('owner', { runner: 'codex', cwd });
    t.after(async () => {
      await activeManager.close('owner', session.id);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(cwd, { recursive: true, force: true });
    });
    await manager.send('owner', session.id, 'first', 'first');
    const queued = await manager.send('owner', session.id, 'second', 'second');
    assert.equal(queued.queued, true);
    assert.equal(queued.submitted, false);
    assert.equal(queued.accepted, false);
    assert.equal(queued.commandId, 'second');
    assert.match(readFileSync(join(root, `${session.id}.journal`), 'utf8'), /"queued":true/);
    assert.equal((await manager.send('owner', session.id, 'second', 'second')).queued, true);
    const deadline = Date.now() + 15_000;
    while (
      !manager
        .read('owner', session.id)
        .commands.some((command) => command.commandId === 'second' && command.state === 'completed')
    ) {
      assert.ok(Date.now() < deadline, 'queued turn must complete');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(readFileSync(join(cwd, 'inputs'), 'utf8'), 'first\nsecond\n');
    assert.equal((await manager.send('owner', session.id, 'second', 'second')).accepted, true);
    await manager.send('owner', session.id, 'restart-hold', 'restart-hold');
    assert.equal(
      (await manager.send('owner', session.id, 'survives-restart', 'survives-restart')).queued,
      true,
    );
    const savedJournal = readFileSync(join(root, `${session.id}.journal`));
    await manager.close('owner', session.id);
    writeFileSync(join(root, `${session.id}.journal`), savedJournal);
    const resumedManager = new NativeSessionManager(root);
    activeManager = resumedManager;
    // Resume must reconcile the restored process directly, without a prior read.
    const resumed = await resumedManager.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.notEqual(resumed.generation, session.generation);
    const resumedDeadline = Date.now() + 15_000;
    while (
      !resumedManager
        .read('owner', session.id)
        .commands.some(
          (command) => command.commandId === 'survives-restart' && command.state === 'completed',
        )
    ) {
      assert.ok(
        Date.now() < resumedDeadline,
        'durable queued input must resume after explicit recovery',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      readFileSync(join(cwd, 'inputs'), 'utf8')
        .split('\n')
        .filter((line) => line === 'survives-restart').length,
      1,
    );
  },
);
