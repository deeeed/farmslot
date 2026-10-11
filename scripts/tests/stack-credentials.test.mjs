import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const keys = ['FARMSLOT_NODE_TOKEN', 'FARMSLOT_GATEWAY_TOKEN', 'FARMSLOT_GATEWAY_PASSWORD'];

function fixture(t, auth = '') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'stack-credentials-')));
  t.after(() => {
    const pidFile = path.join(root, 'runtime/sandbox-dev.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const relative of [
    'scripts/dev.sh',
    'scripts/lib/stack-credentials.sh',
    'scripts/lib/sandbox-home.cjs',
    'projects/farmslot-farm/setup/sandbox-dev.sh',
    'projects/farmslot-farm/setup/sandbox-common.sh',
    'projects/farmslot-farm/setup/sandbox-companion.sh',
  ]) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    copyFileSync(path.join(repo, relative), path.join(root, relative));
  }
  mkdirSync(path.join(root, 'apps/command-center'), { recursive: true });
  mkdirSync(path.join(root, 'apps/companion/scripts/agentic'), { recursive: true });
  writeFileSync(path.join(root, '.env.ports'), 'GATEWAY_PORT=0\nVITE_PORT=0\n');
  if (auth) writeFileSync(path.join(root, '.env.local-auth'), auth);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const capture = path.join(root, 'capture.json');
  const hostHome = path.join(root, 'host-home');
  mkdirSync(hostHome);
  writeFileSync(
    path.join(hostHome, 'credentials.json'),
    JSON.stringify({
      schemaVersion: 1,
      activatedAt: '2026-10-10T00:00:00.000Z',
      principals: [],
      credentials: [],
    }),
  );
  writeFileSync(
    path.join(bin, 'yarn'),
    '#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.env.STACK_CREDENTIAL_CAPTURE,JSON.stringify(Object.fromEntries(["FARMSLOT_NODE_TOKEN","FARMSLOT_GATEWAY_TOKEN","FARMSLOT_GATEWAY_PASSWORD","GATEWAY_URL","GATEWAY_HOST","FARMSLOT_GATEWAY_AUTH_MODE","FARMSLOT_HOME"].map(k=>[k,process.env[k]??null]))));if(process.env.STACK_KEEP_CAPTURE_RUNNING==="1")setInterval(()=>{},20);\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    GATEWAY_PORT: '0',
    VITE_PORT: '0',
    GATEWAY_URL: 'ws://parent.example:7801',
    GATEWAY_HOST: '0.0.0.0',
    FARMSLOT_GATEWAY_AUTH_MODE: 'token',
    FARMSLOT_NODE_TOKEN: 'parent-node',
    FARMSLOT_GATEWAY_TOKEN: 'parent-gateway',
    FARMSLOT_GATEWAY_PASSWORD: 'parent-password',
    FARMSLOT_SLOT_REPO: root,
    FARMSLOT_RUNTIME_DIR: path.join(root, 'runtime'),
    FARMSLOT_HOME: hostHome,
    FARMSLOT_SANDBOX_HOME: '',
    STACK_CREDENTIAL_CAPTURE: capture,
  };
  return {
    root,
    env,
    capture,
    run() {
      execFileSync('bash', [path.join(root, 'scripts/dev.sh')], { env, stdio: 'pipe' });
      return JSON.parse(readFileSync(capture, 'utf8'));
    },
  };
}

test('dev stack drops inherited parent credentials before co-launching its node', (t) => {
  const f = fixture(t);
  const child = f.run();
  for (const key of keys) assert.equal(child[key], null, key);
  assert.equal(child.GATEWAY_URL, 'ws://127.0.0.1:0');
  assert.equal(child.GATEWAY_HOST, '127.0.0.1');
  assert.equal(child.FARMSLOT_GATEWAY_AUTH_MODE, null);
});

test('checkout auth replaces parent node and gateway credentials', (t) => {
  for (const auth of [
    'FARMSLOT_GATEWAY_TOKEN=stack-token\n',
    'FARMSLOT_GATEWAY_PASSWORD=stack-password\n',
  ]) {
    const child = fixture(t, auth).run();
    assert.equal(child.FARMSLOT_NODE_TOKEN, null);
    assert.equal(child.FARMSLOT_GATEWAY_TOKEN, auth.includes('TOKEN=') ? 'stack-token' : null);
    assert.equal(
      child.FARMSLOT_GATEWAY_PASSWORD,
      auth.includes('PASSWORD=') ? 'stack-password' : null,
    );
  }
});

test('sandbox companion clears parent credentials and isolates both child homes', (t) => {
  const f = fixture(t);
  const stub =
    '#!/bin/sh\nset +u\nprintf "%s\\n%s" "$FARMSLOT_NODE_TOKEN$FARMSLOT_GATEWAY_TOKEN$FARMSLOT_GATEWAY_PASSWORD" "$FARMSLOT_HOME"';
  writeFileSync(
    path.join(f.root, 'projects/farmslot-farm/setup/sandbox-dev.sh'),
    stub + ' > "$STACK_CREDENTIAL_CAPTURE.gateway"\n',
  );
  writeFileSync(
    path.join(f.root, 'apps/companion/scripts/agentic/prepare-profile.sh'),
    stub + ' > "$STACK_CREDENTIAL_CAPTURE.companion"\n',
  );
  execFileSync(
    'bash',
    [
      path.join(f.root, 'projects/farmslot-farm/setup/sandbox-companion.sh'),
      '--gateway-port',
      '8808',
      '--metro-port',
      '8181',
    ],
    { env: f.env, stdio: 'pipe' },
  );
  const home = path.join(f.env.FARMSLOT_RUNTIME_DIR, 'home');
  assert.equal(readFileSync(f.capture + '.gateway', 'utf8'), '\n' + home);
  assert.equal(readFileSync(f.capture + '.companion', 'utf8'), '\n' + home);
  assert.equal(existsSync(path.join(home, 'credentials.json')), false);
});

test('sandbox dev clears inherited credentials and home before an older slot dev script', (t) => {
  const f = fixture(t);
  const primary = path.join(f.root, 'primary');
  mkdirSync(primary);
  writeFileSync(
    path.join(f.root, 'projects/farmslot-farm/project.json'),
    JSON.stringify({ primary_repo: primary }),
  );
  writeFileSync(path.join(f.root, '.env.ports'), 'GATEWAY_PORT=0\nVITE_PORT=8809\n');
  writeFileSync(path.join(f.root, 'scripts/dev.sh'), '#!/bin/sh\nexec yarn dev\n');
  const bin = path.join(f.root, 'bin');
  writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    path.join(bin, 'curl'),
    '#!/usr/bin/env node\nconst fs=require("node:fs");if(!fs.existsSync(process.env.FARMSLOT_RUNTIME_DIR+"/sandbox-dev.pid"))process.exit(1);const deadline=Date.now()+1500;function poll(){if(fs.existsSync(process.env.STACK_CREDENTIAL_CAPTURE))process.exit(0);if(Date.now()>=deadline)process.exit(1);setTimeout(poll,10);}poll();\n',
    { mode: 0o755 },
  );
  execFileSync(
    'bash',
    [
      path.join(f.root, 'projects/farmslot-farm/setup/sandbox-dev.sh'),
      'start',
      '--gateway-port',
      '0',
    ],
    {
      env: { ...f.env, STACK_KEEP_CAPTURE_RUNNING: '1', FARMSLOT_RUNS_DIR: '' },
      stdio: 'pipe',
      timeout: 3000,
    },
  );
  const child = JSON.parse(readFileSync(f.capture, 'utf8'));
  for (const key of keys) assert.equal(child[key], null, key);
  assert.equal(child.FARMSLOT_HOME, path.join(f.env.FARMSLOT_RUNTIME_DIR, 'home'));
  assert.equal(existsSync(path.join(child.FARMSLOT_HOME, 'credentials.json')), false);
});

test('sandbox home wins over checkout home settings without copying activated host credentials', (t) => {
  const f = fixture(t);
  const home = path.join(f.root, 'runtime/home');
  mkdirSync(home, { recursive: true });
  f.env.FARMSLOT_HOME = home;
  f.env.FARMSLOT_SANDBOX_HOME = home;
  const hostHome = path.join(f.root, 'host-home');
  const before = readFileSync(path.join(hostHome, 'credentials.json'), 'utf8');
  writeFileSync(
    path.join(f.root, '.env.ports'),
    `GATEWAY_PORT=0\nVITE_PORT=0\nFARMSLOT_HOME=${hostHome}\n`,
  );
  const child = f.run();
  assert.equal(child.FARMSLOT_HOME, home);
  assert.equal(child.GATEWAY_HOST, '127.0.0.1');
  assert.equal(existsSync(path.join(home, 'credentials.json')), false);
  assert.equal(readFileSync(path.join(hostHome, 'credentials.json'), 'utf8'), before);
});

test('stack-local ports restore their own bind host and auth mode after clearing parent policy', (t) => {
  const f = fixture(t, 'FARMSLOT_GATEWAY_PASSWORD=stack-password\n');
  writeFileSync(
    path.join(f.root, '.env.ports'),
    'GATEWAY_PORT=0\nVITE_PORT=0\nGATEWAY_HOST=localhost\nFARMSLOT_GATEWAY_AUTH_MODE=password\n',
  );
  const child = f.run();
  assert.equal(child.GATEWAY_HOST, 'localhost');
  assert.equal(child.FARMSLOT_GATEWAY_AUTH_MODE, 'password');
  assert.equal(child.FARMSLOT_GATEWAY_PASSWORD, 'stack-password');
  assert.equal(child.FARMSLOT_NODE_TOKEN, null);
});

function warmStackFixture(t) {
  const f = fixture(t);
  mkdirSync(path.join(f.root, 'primary'));
  writeFileSync(
    path.join(f.root, 'projects/farmslot-farm/project.json'),
    JSON.stringify({ primary_repo: path.join(f.root, 'primary') }),
  );
  writeFileSync(path.join(f.root, '.env.ports'), 'GATEWAY_PORT=0\nVITE_PORT=8809\n');
  writeFileSync(path.join(f.root, 'bin/lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    path.join(f.root, 'bin/yarn'),
    `#!/usr/bin/env node
const fs=require('node:fs');const file=process.env.STACK_CREDENTIAL_CAPTURE;
const prior=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{generation:0};
fs.writeFileSync(file,JSON.stringify({pid:process.pid,generation:prior.generation+1,nodeToken:process.env.FARMSLOT_NODE_TOKEN??null}));setInterval(()=>{},20);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(f.root, 'bin/curl'),
    `#!/usr/bin/env node
const fs=require('node:fs');const file=process.env.STACK_CREDENTIAL_CAPTURE;const marker=process.env.FARMSLOT_RUNTIME_DIR+'/sandbox-dev.pid';const deadline=Date.now()+1500;
if(!fs.existsSync(marker))process.exit(1);
function ready(){return fs.existsSync(file)&&fs.existsSync(marker)&&JSON.parse(fs.readFileSync(file,'utf8')).pid===Number(fs.readFileSync(marker,'utf8'));}
function poll(){if(ready())process.exit(0);if(Date.now()>=deadline)process.exit(1);setTimeout(poll,10);}poll();
`,
    { mode: 0o755 },
  );
  return {
    ...f,
    start() {
      execFileSync(
        'bash',
        [
          path.join(f.root, 'projects/farmslot-farm/setup/sandbox-dev.sh'),
          'start',
          '--gateway-port',
          '0',
        ],
        { env: { ...f.env, FARMSLOT_RUNS_DIR: '' }, timeout: 3000, stdio: 'pipe' },
      );
      return JSON.parse(readFileSync(f.capture, 'utf8'));
    },
    fingerprint: path.join(f.env.FARMSLOT_RUNTIME_DIR, 'launch-fingerprint'),
  };
}

test('warm reuse restarts a healthy stack without a launch record and reuses an unchanged launch', (t) => {
  const f = warmStackFixture(t);
  const first = f.start();
  assert.equal(f.start().pid, first.pid);
  rmSync(f.fingerprint);
  const restarted = f.start();
  assert.equal(restarted.generation, first.generation + 1);
  assert.notEqual(restarted.pid, first.pid);
  assert.equal(statSync(f.fingerprint).mode & 0o777, 0o600);
});

test('warm reuse restarts after stack script or own credentials change', (t) => {
  const f = warmStackFixture(t);
  const first = f.start();
  const script = path.join(f.root, 'scripts/dev.sh');
  writeFileSync(script, readFileSync(script, 'utf8') + '\n# updated launch script\n');
  assert.equal(f.start().generation, first.generation + 1);
  writeFileSync(
    path.join(f.root, '.env.local-auth'),
    'FARMSLOT_GATEWAY_TOKEN=stack-fresh\nFARMSLOT_NODE_TOKEN=stack-fresh\n',
  );
  const refreshed = f.start();
  assert.equal(refreshed.generation, first.generation + 2);
  assert.equal(refreshed.nodeToken, 'stack-fresh');
  assert.ok(!readFileSync(f.fingerprint, 'utf8').includes('stack-fresh'));
});

test('primary companion keeps the operator home and creates no sandbox home', (t) => {
  const f = fixture(t);
  writeFileSync(
    path.join(f.root, 'projects/farmslot-farm/project.json'),
    JSON.stringify({ primary_repo: f.root }),
  );
  const stub = '#!/bin/sh\nprintf "%s" "$FARMSLOT_HOME"';
  writeFileSync(
    path.join(f.root, 'projects/farmslot-farm/setup/sandbox-dev.sh'),
    stub + ' > "$STACK_CREDENTIAL_CAPTURE.gateway"\n',
  );
  writeFileSync(
    path.join(f.root, 'apps/companion/scripts/agentic/prepare-profile.sh'),
    stub + ' > "$STACK_CREDENTIAL_CAPTURE.companion"\n',
  );
  execFileSync(
    'bash',
    [
      path.join(f.root, 'projects/farmslot-farm/setup/sandbox-companion.sh'),
      '--gateway-port',
      '8808',
      '--metro-port',
      '8181',
    ],
    { env: f.env, stdio: 'pipe' },
  );
  assert.equal(readFileSync(f.capture + '.gateway', 'utf8'), f.env.FARMSLOT_HOME);
  assert.equal(readFileSync(f.capture + '.companion', 'utf8'), f.env.FARMSLOT_HOME);
  assert.equal(existsSync(path.join(f.env.FARMSLOT_RUNTIME_DIR, 'home')), false);
});

test('sandbox home preload is idempotent and preserves other Node options', (t) => {
  const f = fixture(t);
  const output = execFileSync(
    'bash',
    [
      '-c',
      'source "$FARMSLOT_SLOT_REPO/scripts/lib/stack-credentials.sh"; isolate_sandbox_home "$FARMSLOT_RUNTIME_DIR"; isolate_sandbox_home "$FARMSLOT_RUNTIME_DIR"; printf "%s" "$NODE_OPTIONS"',
    ],
    { env: { ...f.env, NODE_OPTIONS: '--no-warnings' }, encoding: 'utf8' },
  );
  assert.equal(output.match(/--require/g)?.length, 1);
  assert.ok(output.endsWith(' --no-warnings'));
});

test('configured sandbox lifecycle hooks select current support over an older checkout', (t) => {
  const f = fixture(t);
  const project = JSON.parse(
    readFileSync(path.join(repo, 'projects/farmslot-farm/project.json'), 'utf8'),
  );
  const support = path.join(f.root, 'support');
  const relative = 'projects/farmslot-farm/setup/sandbox-dev.sh';
  mkdirSync(path.dirname(path.join(support, relative)), { recursive: true });
  writeFileSync(
    path.join(support, relative),
    '#!/bin/sh\nprintf "%s %s" "$1" "$FARMSLOT_SLOT_REPO"\n',
  );
  writeFileSync(path.join(f.root, relative), '#!/bin/sh\nexit 99\n');
  for (const hook of [
    project.hooks.health_check,
    project.hooks.dev_server_check,
    project.hooks.teardown,
    project.prepare.profiles.sandbox.hooks.preflight,
    ...Object.values(project.resources['dev-server'].hooks),
  ]) {
    const command = hook
      .replaceAll('{{repo}}', f.root)
      .replaceAll('{{farmslot_dir}}', support)
      .replaceAll('{{port}}', '8808');
    const result = execFileSync('bash', ['-c', command], { env: f.env, encoding: 'utf8' });
    assert.match(result, /^(start|health|stop) /);
    assert.ok(result.endsWith(' ' + f.root));
  }
});
