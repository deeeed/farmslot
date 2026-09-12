import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexNativeAdapter } from './codex.js';
import type { NativeEventInput } from './types.js';

const fixture = `#!/usr/bin/env node
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-one'}}});
 if(m.method==='turn/start') {
  send({method:'turn/started',params:{threadId:'thread-one',turn:{id:'turn-one'}}});
  send({id:m.id,result:{turn:{id:'turn-one'}}});
  send({id:78,method:'item/commandExecution/requestApproval',params:{threadId:'thread-one',turnId:'turn-one',itemId:'tool-one',command:'pwd'}});
 }
 if(m.id===78 && m.result) {
  send({method:'item/completed',params:{threadId:'thread-one',item:{id:'tool-one',type:'commandExecution',status:m.result.decision==='decline'?'declined':'completed'}}});
  send({method:'turn/completed',params:{threadId:'thread-one',turn:{id:'turn-one',status:'completed'}}});
 }
});`;

test('Codex correlates structured acceptance and denies only the exact pending request', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-codex-test-'));
  const executable = join(cwd, 'codex');
  await writeFile(executable, fixture);
  await chmod(executable, 0o755);
  const events: NativeEventInput[] = [];
  const session = await codexNativeAdapter.start({ cwd, executable }, (event) =>
    events.push(event),
  );
  try {
    await session.send('Read cwd', 'command-one');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      events.find((event) => event.type === 'command.accepted')?.commandId,
      'command-one',
    );
    assert.equal(events.find((event) => event.type === 'turn.started')?.turnId, 'turn-one');
    assert.equal(events.find((event) => event.type === 'approval.requested')?.request?.id, '78');
    await assert.rejects(session.respond('other', { decision: 'approve' }), /stale/);
    await session.respond('78', { decision: 'deny' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.find((event) => event.type === 'tool.completed')?.tool?.status, 'declined');
    assert.equal(events.find((event) => event.type === 'turn.completed')?.status, 'completed');
    await assert.rejects(session.respond('78', { decision: 'approve' }), /stale/);
  } finally {
    await session.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
