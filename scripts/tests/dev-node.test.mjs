import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dev-node-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'yarn'),
    `#!${process.execPath}
process.stdout.write(JSON.stringify({args:process.argv.slice(2),owner:process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID??null,token:process.env.FARMSLOT_NODE_TOKEN??null,state:process.env.FARMSLOT_NATIVE_STATE_DIR??null,hmr:process.env.FARMSLOT_DEV_UI_HMR??null}));
`,
    { mode: 0o755 },
  );
  const env = {
    HOME: root,
    PATH: bin + path.delimiter + process.env.PATH,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'farm-automation',
    FARMSLOT_NODE_TOKEN: 'fixture-node-token',
    FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  };
  return {
    root,
    env,
    run(script, input = env) {
      return JSON.parse(
        execFileSync('bash', [path.join(repo, 'scripts', script)], {
          env: input,
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .at(-1),
      );
    },
  };
}

test('node owner override is child-only and keeps the selected token and native-state base', (t) => {
  const f = fixture(t);
  f.env.FARMSLOT_NODE_NATIVE_OWNER_PRINCIPAL_ID = 'arthur-native';
  const node = f.run('dev-node.sh');
  assert.deepEqual(node, {
    args: ['workspace', '@farmslot/node', 'dev'],
    owner: 'arthur-native',
    token: 'fixture-node-token',
    state: f.env.FARMSLOT_NATIVE_STATE_DIR,
    hmr: null,
  });
  assert.equal(f.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID, 'farm-automation');
  const gateway = f.run('dev-gateway.sh');
  assert.equal(gateway.owner, 'farm-automation');
  assert.deepEqual(gateway.args, ['workspace', '@farmslot/gateway', 'start']);
});

test('an unset node override inherits the existing owner and an explicit empty value disables it', (t) => {
  const f = fixture(t);
  assert.equal(f.run('dev-node.sh').owner, 'farm-automation');
  f.env.FARMSLOT_NODE_NATIVE_OWNER_PRINCIPAL_ID = '';
  assert.equal(f.run('dev-node.sh').owner, '');
});

test('both command-center node dev entries use the owner-scoping wrapper', () => {
  const { scripts } = JSON.parse(
    readFileSync(path.join(repo, 'apps/command-center/package.json'), 'utf8'),
  );
  assert.ok(scripts.dev.includes('bash ../../scripts/dev-node.sh'));
  assert.ok(scripts.dev.includes('bash ../../scripts/dev-ui.sh'));
  assert.equal(scripts['dev:node'], 'bash ../../scripts/dev-node.sh');
});

test('shared stack leaves the HMR default out of gateway, node and sandbox parents', (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, 'apps/command-center'), { recursive: true });
  writeFileSync(path.join(f.root, '.env.ports'), 'GATEWAY_HOST=127.0.0.1\n');
  const parent = f.run('dev.sh', {
    ...f.env,
    FARMSLOT_SLOT_REPO: f.root,
    FARMSLOT_HOME: path.join(f.root, 'home'),
    GATEWAY_PORT: '0',
    VITE_PORT: '0',
  });
  assert.equal(parent.hmr, null, 'the shared stack must not export its UI default');
  assert.equal(f.run('dev-ui.sh').hmr, '0');
  assert.equal(f.run('dev-node.sh').hmr, null);
  assert.equal(f.run('dev-gateway.sh').hmr, null);
  assert.equal(f.run('dev-ui.sh', { ...f.env, FARMSLOT_DISABLE_ORCHESTRATION: '1' }).hmr, '1');
  for (const value of ['0', '1']) {
    assert.equal(f.run('dev-ui.sh', { ...f.env, FARMSLOT_DEV_UI_HMR: value }).hmr, value);
  }
});
