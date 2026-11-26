import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { type NativeSessionEvent } from '@farmslot/protocol';

import type { NativeSessionManager } from './manager.js';
import { gitEnvironment } from './workspace.js';

const fixture = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const fs = require('node:fs');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
let thread, turn, timer;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume') {
  fs.writeFileSync('native-start.json',JSON.stringify({params:m.params,env:{probe:process.env.NATIVE_WORKER_PROBE,omc:process.env.DISABLE_OMC,omx:process.env.DISABLE_OMX}}),{mode:0o600});
  thread=m.params.threadId || 'thread-'+process.pid;
  send({id:m.id,result:{thread:{id:thread}}});
 }
 if(m.method==='turn/start') {
  fs.writeFileSync('native-turn.json',JSON.stringify(m.params),{mode:0o600});
  const text=m.params.input[0].text; turn='turn-'+m.id;
  fs.appendFileSync('inputs',text+'\\n');
  if(text==='unknown') { process.exit(23); }
  send({id:m.id,result:{turn:{id:turn}}});
  send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
  if(text==='approval') {send({id:7,method:'item/commandExecution/requestApproval',params:{threadId:thread,command:'fixture tool'}});return;}
  if(text==='self-resolved') {send({id:8,method:'item/commandExecution/requestApproval',params:{threadId:thread,command:'fixture tool'}});send({method:'serverRequest/resolved',params:{threadId:thread,requestId:8}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});return;}
  send({method:'item/started',params:{threadId:thread,item:{id:'tool',type:'commandExecution',command:'fixture tool'}}});
  if(text==='crash' && fs.existsSync('gate-crash-descendant')) while(!fs.existsSync('release-crash-descendant')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  const child = require('node:child_process').spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});
  fs.writeFileSync('descendant',String(child.pid));
  const complete=()=>{
   child.kill(); fs.appendFileSync('effects',text+'\\n');
   for(let i=0;i<300;i++) send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'text',delta:'x'}});
   send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
  };
  if(fs.existsSync('.manual-turns')) {
   const release='.release-'+turn;
   fs.writeFileSync('.turn-ready',release);
   timer=setInterval(()=>{
    if(!fs.existsSync(release))return;
    clearInterval(timer);fs.unlinkSync(release);fs.unlinkSync('.turn-ready');complete();
   },5);
  } else timer=setTimeout(()=>{complete();},600);
 }
 if(m.id===7 && !m.method){fs.appendFileSync('decisions',JSON.stringify(m.result)+'\\n');send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}
 if(m.method==='turn/steer'){fs.appendFileSync('steers',m.params.input[0].text+'\\n');if(m.params.input[0].text==='exit')process.exit(1);if(m.params.input[0].text==='refuse')return send({id:m.id,error:{code:-32600,message:'no active turn to steer'}});return send({id:m.id,result:{turnId:m.params.expectedTurnId}});}
 if(m.method==='turn/interrupt'){clearTimeout(timer);send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'interrupted'}}});}
});`;

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Git in a test repository, with a fixed identity. */
const gitIn =
  (cwd: string) =>
  (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
      cwd,
      env: gitEnvironment(),
      encoding: 'utf8',
    });

/** Every event of a session, page by page. */
const allEvents = (manager: NativeSessionManager, id: string) => {
  const all: NativeSessionEvent[] = [];
  for (let after = 0; ; ) {
    const page = manager.read('owner', id, after, 500);
    all.push(...page.events);
    if (!page.hasMore) return all;
    after = page.cursor;
  }
};

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Test condition timed out');
    await delay();
  }
}

interface DurabilityFixtureOptions {
  manualTurns?: boolean;
}

function setup(options: DurabilityFixtureOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'native-durability-'));
  writeFileSync(join(cwd, 'codex'), fixture);
  if (options.manualTurns) writeFileSync(join(cwd, '.manual-turns'), '');
  chmodSync(join(cwd, 'codex'), 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${cwd}${delimiter}${oldPath}`;
  return {
    cwd,
    root: join(cwd, 'state'),
    async completeTurn() {
      const ready = join(cwd, '.turn-ready');
      await until(() => existsSync(ready));
      writeFileSync(join(cwd, readFileSync(ready, 'utf8')), '');
    },
    restore() {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// Supervisor and host carry the unique home in their argv, so a failed or slow start
// can still be found and killed even before host.json names them.
function nativeStack(root: string): number[] {
  return (spawnSync('pgrep', ['-f', root], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map(Number);
}

/**
 * The detached supervisor leads its own process group, which its host and census
 * `ps` join; killing the group reaches a host forked after a snapshot. A host whose
 * group is gone is killed directly. Teardown is confirmed, never assumed.
 */
async function stopNativeStack(fixture: ReturnType<typeof setup>): Promise<void> {
  const kill = (pid: number) => {
    for (const target of [-pid, pid])
      try {
        process.kill(target, 'SIGKILL');
      } catch (error) {
        if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
  };
  const deadline = Date.now() + 3_000;
  while (nativeStack(fixture.root).length && Date.now() < deadline) {
    nativeStack(fixture.root).forEach(kill);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fixture.restore();
  assert.deepEqual(nativeStack(fixture.root), [], 'no supervisor or host outlives the test');
}

/** A committed test repository, and Git in it. */
function testRepository() {
  const repo = mkdtempSync(join(tmpdir(), 'native-turn-repo-'));
  const git = gitIn(repo);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { repo, git };
}

/**
 * Record an event on a session as its adapter would, after the fact: the one place tests reach
 * the manager's private session table and append path, so a rename breaks only this helper.
 */
function appendLateEvent(manager: NativeSessionManager, record: unknown, type: 'session.closed') {
  const append: unknown = Reflect.get(manager, 'append');
  assert.ok(typeof append === 'function');
  append.call(manager, record, { type });
}
function sessionRecordOf(manager: NativeSessionManager, id: string): unknown {
  const sessions: unknown = Reflect.get(manager, 'sessions');
  assert.ok(sessions instanceof Map);
  return sessions.get(id);
}

export {
  allEvents,
  appendLateEvent,
  delay,
  fixture,
  gitIn,
  nativeStack,
  sessionRecordOf,
  setup,
  stopNativeStack,
  testRepository,
  until,
};
