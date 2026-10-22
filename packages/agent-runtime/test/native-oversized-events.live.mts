// Opt-in protocol proof. Uses a private native host and fixture executable, never a farm run.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NativeSessionInfo } from '@farmslot/protocol';

import { NativeSessionClient } from '../src/native/client.js';
import { type HostIdentity, socketDirectory } from '../src/native/ipc.js';
import { alive, readJson } from '../src/native/storage.js';

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'private native RPC did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex-cli 0.154.0');process.exit(0)}
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'oversized-proof'}}});
 if(m.method==='turn/start'){
  const turn='turn-'+m.id,item={id:'tool-'+m.id,type:'commandExecution',command:'fixture output'};
  send({id:m.id,result:{turn:{id:turn}}});
  send({method:'turn/started',params:{turn:{id:turn}}});
  send({method:'item/started',params:{item}});
  send({method:'item/completed',params:{item:{...item,status:'completed',aggregatedOutput:'x'.repeat(1100000),exitCode:0}}});
  send({method:'turn/completed',params:{turn:{id:turn,status:'completed'}}});
 }
});`;

const cwd = await mkdtemp(join(tmpdir(), 'native-oversized-rpc-'));
const root = join(cwd, 'state');
const previousPath = process.env.PATH;
const previousConfig = process.env.TSX_TSCONFIG_PATH;
const client = new NativeSessionClient(root);
let session: NativeSessionInfo | undefined;
const proof = {
  fixtureOnly: true,
  rpcCommandsCompleted: 0,
  diagnosticEventBytes: 0,
  nativeSessionAndHostUnchanged: false,
  cleanupConfirmed: false,
  productRunOperations: 0,
};
try {
  await writeFile(join(cwd, 'codex'), fixture);
  await chmod(join(cwd, 'codex'), 0o700);
  process.env.PATH = cwd + delimiter + previousPath;
  process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
  session = await client.create('proof-owner', { runner: 'codex', cwd });
  const initial = session;
  for (const commandId of ['first', 'second']) {
    await client.send('proof-owner', initial.id, commandId, commandId);
    await until(async () => {
      const snapshot = await client.read('proof-owner', initial.id);
      return (
        snapshot.session.state === 'failed' ||
        snapshot.commands.some((c) => c.commandId === commandId && c.state === 'completed')
      );
    });
    const snapshot = await client.read('proof-owner', initial.id);
    assert.equal(snapshot.session.state, 'idle', snapshot.session.error);
    assert.equal(snapshot.commands.find((c) => c.commandId === commandId)?.state, 'completed');
    assert.equal(snapshot.session.nativeSessionId, initial.nativeSessionId);
    assert.equal(snapshot.session.hostPid, initial.hostPid);
    const tool = snapshot.events.find(
      (e) => e.commandId === commandId && e.type === 'tool.completed',
    );
    assert.ok(tool);
    assert.equal(tool.tool?.status, 'completed');
    assert.match(String(tool.tool?.output), /omitted.*bytes/);
    proof.diagnosticEventBytes = Math.max(
      proof.diagnosticEventBytes,
      Buffer.byteLength(JSON.stringify(tool)),
    );
    assert.ok(proof.diagnosticEventBytes < 65536);
    proof.rpcCommandsCompleted++;
  }
  proof.nativeSessionAndHostUnchanged = true;
} finally {
  try {
    if (session) await client.close('proof-owner', session.id);
  } finally {
    const hostFile = join(root, 'host.json');
    if (existsSync(hostFile)) {
      const host = readJson<HostIdentity>(hostFile);
      if (alive(host.pid)) process.kill(host.pid, 'SIGTERM');
      await until(() => !alive(host.pid));
    }
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.TSX_TSCONFIG_PATH;
    else process.env.TSX_TSCONFIG_PATH = previousConfig;
    await rm(socketDirectory(root), { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    proof.cleanupConfirmed = true;
  }
}
if (process.argv[2])
  await writeFile(resolve(process.argv[2]), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof));
