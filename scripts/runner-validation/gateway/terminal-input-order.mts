// Opt-in remote terminal proof. Owns only a new private gateway, node and tmux socket.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'remote-host': { type: 'string' },
    'remote-source': { type: 'string' },
    'gateway-host': { type: 'string' },
    output: { type: 'string' },
    'preflight-only': { type: 'boolean' },
  },
});
const remoteHost = values['remote-host'];
const remoteSource = values['remote-source'];
const gatewayHost = values['gateway-host'];
assert(
  remoteHost && remoteSource && gatewayHost && values.output,
  'Explicit host/source/output inputs required',
);
assert(!remoteHost.startsWith('-') && /^[a-zA-Z0-9_.@-]+$/.test(remoteHost));
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.resolve(values.output);
await mkdir(output, { mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function remote(program: string, input: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=8',
        remoteHost!,
        'python3 -c ' + quote(program),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve(JSON.parse(stdout))
        : reject(new Error('Owned remote operation failed: ' + stderr)),
    );
    child.stdin.end(JSON.stringify(input));
  });
}
const preflight = await remote(
  String.raw`
import json,sys,pathlib,subprocess,os
p=json.load(sys.stdin);source=pathlib.Path(p['source'])
assert (source/'services/node/src/index.ts').is_file()
assert (source/'node_modules/tsx/package.json').is_file()
print(json.dumps({'status':'PASS','source':str(source),'node':subprocess.check_output(['node','--version'],text=True).strip(),'load':os.getloadavg()}))
`,
  { source: remoteSource },
);
await save('preflight.json', preflight);
if (values['preflight-only']) {
  console.log(JSON.stringify({ status: 'PASS', preflightOnly: true, output }));
  process.exit(0);
}

const id = randomUUID();
// macOS's default temporary directory can exceed tmux's socket path limit.
const root = await mkdtemp('/tmp/terminal-input-');
const machine = 'input-proof-' + id;
const slotId = 'input-slot-' + id;
for (const key of Object.keys(process.env))
  if (key.startsWith('FARMSLOT_') || ['TMUX', 'TMUX_PANE', 'NODE_TEST_CONTEXT'].includes(key))
    delete process.env[key];
for (const name of ['home', 'runs', 'pool', 'projects', 'native', 'analytics', 'tmux'])
  await mkdir(path.join(root, name), { mode: 0o700 });
for (const name of [
  'scripts',
  'packages',
  'services',
  'apps',
  'node_modules',
  'schemas',
  'package.json',
  'CLAUDE.md',
])
  await symlink(path.join(source, name), path.join(root, name));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_ANALYTICS_DIR: path.join(root, 'analytics'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'fixture-status.json'),
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  TMUX_TMPDIR: path.join(root, 'tmux'),
});
await writeFile(process.env.FARMSLOT_TEST_STATUS_FILE!, '{"slots":[]}\n');
const remoteRoot = '/tmp/terminal-input-' + id;
await writeFile(
  path.join(root, 'pool/remote.json'),
  JSON.stringify({
    machine,
    project: 'input-proof',
    platform: 'cli',
    os: 'macos',
    host: remoteHost,
    ssh_user: process.env.USER,
    slots: [
      {
        id: slotId,
        enabled: true,
        mode: 'dispatch',
        project: 'input-proof',
        repo: remoteRoot,
        session: slotId,
        resources: {},
      },
    ],
  }),
);
const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { getNode } = await import('../../../services/gateway/src/fleet/machine-registry.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const { createTerminalInputQueue } =
  await import('../../../apps/companion/src/lib/terminal-input-queue.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Terminal input proof' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
const credential = auth.writer.issueCredential(owner.id, 'Disposable terminal client');
const nodeOwner = auth.writer.createPrincipal(
  { type: 'node', displayName: 'Terminal input proof node', machine },
  [],
);
const nodeCredential = auth.writer.issueCredential(nodeOwner.id, 'Disposable node');
const server = createServer();
const wss = createWebSocketServer(server, auth);
const connections: Awaited<ReturnType<InstanceType<typeof GatewayClient>['connect']>>[] = [];
let remoteAttempted = false;
let failure: unknown;
try {
  await new Promise<void>((yes) => server.listen(0, '0.0.0.0', yes));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const gateway = `ws://${gatewayHost}:${address.port}/ws`;
  remoteAttempted = true;
  await save(
    'remote-setup.json',
    await remote(
      String.raw`
import json,sys,os,pathlib,subprocess,time,shlex
p=json.load(sys.stdin);r=pathlib.Path(p['root']);r.mkdir(mode=0o700)
(r/'owner').write_text(p['id']);os.chmod(r/'owner',0o600)
for n in ['home','pool','native','analytics','tmux']:(r/n).mkdir(mode=0o700)
for n in ['scripts','packages','services']:(r/n).symlink_to(pathlib.Path(p['source'])/n)
sink="import os,sys,tty\ntty.setraw(0)\nf=open(sys.argv[1],'xb',buffering=0)\nopen(sys.argv[2],'x').close()\nwhile True:\n b=os.read(0,4096)\n if not b: break\n f.write(b)\n os.write(1,b)\n"
(r/'sink.py').write_text(sink)
socket=str(r/'tmux'/('tmux-'+str(os.getuid()))/'default');pathlib.Path(socket).parent.mkdir(mode=0o700)
env={k:v for k,v in os.environ.items() if not k.startswith('FARMSLOT_') and k not in ['TMUX','TMUX_PANE','GATEWAY_URL','NODE_OPTIONS','NODE_TEST_CONTEXT']}
env.update({'FARMSLOT_ROOT':str(r),'FARMSLOT_HOME':str(r/'home'),'FARMSLOT_POOL_DIR':str(r/'pool'),'FARMSLOT_NATIVE_STATE_DIR':str(r/'native'),'FARMSLOT_ANALYTICS_DIR':str(r/'analytics'),'TMUX_TMPDIR':str(r/'tmux'),'GATEWAY_URL':p['gateway'],'MACHINE_NAME':p['machine'],'FARMSLOT_NODE_TOKEN':p['token'],'TSX_TSCONFIG_PATH':str(pathlib.Path(p['source'])/'services/gateway/tsconfig.json')})
state={'socket':socket,'slot':p['slot'],'id':p['id'],'tmuxStarted':False};(r/'state.json').write_text(json.dumps(state));os.chmod(r/'state.json',0o600)
subprocess.run(['tmux','-S',socket,'-f','/dev/null','new-session','-d','-s',p['slot'],'-c',str(r),'python3 '+shlex.quote(str(r/'sink.py'))+' '+shlex.quote(str(r/'received.bin'))+' '+shlex.quote(str(r/'ready'))],env=env,check=True)
state['tmuxStarted']=True;(r/'state.json').write_text(json.dumps(state))
log=(r/'node.log').open('xb')
node=subprocess.Popen(['node','--import',str(pathlib.Path(p['source'])/'node_modules/tsx/dist/loader.mjs'),str(pathlib.Path(p['source'])/'services/node/src/index.ts')],cwd=r,env=env,stdout=log,stderr=log,start_new_session=True)
birth=subprocess.check_output(['ps','-p',str(node.pid),'-o','lstart='],text=True).strip()
state.update({'nodePid':node.pid,'nodeBirth':birth});(r/'state.json').write_text(json.dumps(state))
end=time.monotonic()+8
while not (r/'ready').exists():
 assert time.monotonic()<end,'Remote byte sink did not become ready'
 time.sleep(.02)
print(json.dumps({**state,'root':str(r),'load':os.getloadavg()}))
`,
      {
        source: remoteSource,
        root: remoteRoot,
        id,
        machine,
        slot: slotId,
        gateway,
        token: nodeCredential.secret,
      },
    ),
  );
  const deadline = Date.now() + 15_000;
  while (!getNode(machine)) {
    assert(Date.now() < deadline, 'Owned remote node did not register');
    await new Promise((yes) => setTimeout(yes, 50));
  }
  for (let i = 0; i < 2; i++)
    connections.push(
      await new GatewayClient({
        url: `ws://127.0.0.1:${address.port}/ws`,
        timeout: 60_000,
        credential: { token: credential.secret },
      }).connect(),
    );
  let expected = '';
  const observations = [];
  async function verify(label: string) {
    const observed = await remote(
      String.raw`
import json,sys,pathlib,base64,os
p=json.load(sys.stdin);r=pathlib.Path(p['root']);assert (r/'owner').read_text()==p['id']
print(json.dumps({'bytesBase64':base64.b64encode((r/'received.bin').read_bytes()).decode(),'load':os.getloadavg()}))
`,
      { root: remoteRoot, id },
    );
    assert.equal(
      Buffer.from(String(observed.bytesBase64), 'base64').toString(),
      expected,
      label + ' actual remote stdin bytes',
    );
    observations.push({ label, bytes: expected.length, ...observed });
  }
  for (let i = 0; i < connections.length; i++) {
    const text = `client${i}-` + '0123456789abcdef'.repeat(4) + '\r';
    const calls = [...text].map((data) => connections[i]!.call('terminal.input', { slotId, data }));
    await Promise.all(calls);
    expected += text;
    await verify('concurrent keys client ' + i);
  }
  let batches = 0;
  const queue = createTerminalInputQueue(async (data) => {
    batches++;
    await connections[0]!.call('terminal.input', { slotId, data });
  });
  const text = 'Companion-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(12) + '\r';
  await Promise.all([...text].map((data) => queue.write(data)));
  expected += text;
  assert.equal(
    batches,
    2,
    'Fast typing while first request is pending forms exactly one following batch',
  );
  await verify('Companion batching and Enter');
  queue.dispose();
  await save('result.json', {
    status: 'PASS',
    slotId,
    machine,
    remoteHost,
    batches,
    observations,
    source,
    limitation:
      'Real authenticated protocol and production remote node proof; no native UI or OTA claim.',
  });
} catch (error) {
  failure = error;
  await save('failure.json', { message: error instanceof Error ? error.message : String(error) });
} finally {
  const errors: string[] = [];
  if (remoteAttempted) {
    try {
      await save(
        'remote-cleanup.json',
        await remote(
          String.raw`
import json,sys,pathlib,subprocess,os,signal,time
p=json.load(sys.stdin);r=pathlib.Path(p['root']);assert (r/'owner').read_text()==p['id'];s=json.loads((r/'state.json').read_text());assert s['id']==p['id']
check=subprocess.run(['ps','-p',str(s.get('nodePid',0)),'-o','lstart='],text=True,capture_output=True)
if check.returncode==0:
 assert check.stdout.strip()==s['nodeBirth'],'Owned node birth changed'
 os.kill(s['nodePid'],signal.SIGTERM)
if s['tmuxStarted']:subprocess.run(['tmux','-S',s['socket'],'kill-server'],check=True)
end=time.monotonic()+5
while s.get('nodePid') and subprocess.run(['ps','-p',str(s['nodePid'])],capture_output=True).returncode==0:
 assert time.monotonic()<end,'Owned node did not stop'
 time.sleep(.05)
# tmux can leave an inert socket inode after kill-server. Prove no server or owner.
probe=subprocess.run(['tmux','-S',s['socket'],'list-sessions'],capture_output=True)
assert probe.returncode==1,'Owned tmux server still answers'
owners=subprocess.run(['lsof','-t',s['socket']],capture_output=True)
assert owners.returncode==1 and not owners.stdout,'Owned socket still has an open owner'
print(json.dumps({'status':'PASS','nodeStopped':True,'privateSocketListening':False,'staleSocketFileRetained':pathlib.Path(s['socket']).exists(),'rootRetained':str(r)}))
`,
          { root: remoteRoot, id },
        ),
      );
    } catch (error) {
      errors.push(String(error));
    }
  }
  for (const connection of connections) connection.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((yes) => wss.close(() => yes()));
  if (server.listening)
    await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())));
  await save('cleanup.json', {
    status: errors.length ? 'FAIL' : 'PASS',
    errors,
    privateGatewayStopped: !server.listening,
    retainedRoot: root,
  });
  if (errors.length && !failure) failure = new Error(errors.join('; '));
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'PASS', output, slotId }));
