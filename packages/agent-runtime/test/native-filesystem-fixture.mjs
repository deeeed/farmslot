import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A protocol contract regression fixture. Production sandbox enforcement has a separate live gate.
export async function fixture(confirm) {
  const root = await mkdtemp(join(tmpdir(), 'native-filesystem-contract-'));
  const executable = join(root, 'runner');
  const requests = join(root, 'requests.jsonl');
  const argv = join(root, 'argv.json');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n');
 if (message.type === 'control_request' && message.request.subtype === 'initialize') {
  process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:message.request_id,subtype:'success',response:{}}})+'\\n');
  return;
 }
 if (message.id === undefined) return;
 if (message.method === 'turn/start') {
  require('node:child_process').execFileSync(process.execPath, ['-e', 'require(\"node:fs\").writeFileSync(\"command-ran\",\"ok\")']);
  process.stdout.write(JSON.stringify({id:message.id,result:{turn:{id:'turn'}}})+'\\n');
  process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}})+'\\n');
  return;
 }
 const result = ['thread/start', 'thread/resume'].includes(message.method) ? {
  thread: {id:'thread'}, activePermissionProfile: {id:${JSON.stringify(confirm ? 'farmslot-read-only-source' : ':workspace')}}
 } : {};
 process.stdout.write(JSON.stringify({id:message.id,result}) + '\\n');
});\n`,
  );
  await chmod(executable, 0o755);
  return { root, executable, requests, argv };
}
