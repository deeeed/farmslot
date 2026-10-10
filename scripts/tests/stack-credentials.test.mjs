import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const keys = ['FARMSLOT_NODE_TOKEN', 'FARMSLOT_GATEWAY_TOKEN', 'FARMSLOT_GATEWAY_PASSWORD'];

function fixture(t, auth = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'stack-credentials-'));
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
    'projects/farmslot-farm/setup/sandbox-dev.sh',
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
  writeFileSync(
    path.join(bin, 'yarn'),
    '#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.env.STACK_CREDENTIAL_CAPTURE,JSON.stringify(Object.fromEntries(["FARMSLOT_NODE_TOKEN","FARMSLOT_GATEWAY_TOKEN","FARMSLOT_GATEWAY_PASSWORD","GATEWAY_URL","GATEWAY_HOST","FARMSLOT_GATEWAY_AUTH_MODE"].map(k=>[k,process.env[k]??null]))));if(process.env.STACK_KEEP_CAPTURE_RUNNING==="1")setInterval(()=>{},20);\n',
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

test('sandbox companion clears parent credentials before both child entry points', (t) => {
  const f = fixture(t);
  const stub =
    '#!/bin/sh\nset +u\nprintf "%s" "$FARMSLOT_NODE_TOKEN$FARMSLOT_GATEWAY_TOKEN$FARMSLOT_GATEWAY_PASSWORD"';
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
  assert.equal(readFileSync(f.capture + '.gateway', 'utf8'), '');
  assert.equal(readFileSync(f.capture + '.companion', 'utf8'), '');
});

test('sandbox dev clears inherited credentials before delegating to an older slot dev script', (t) => {
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
