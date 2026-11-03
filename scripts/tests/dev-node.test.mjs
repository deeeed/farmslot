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
process.stdout.write(JSON.stringify({args:process.argv.slice(2),owner:process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID??null,token:process.env.FARMSLOT_NODE_TOKEN??null,state:process.env.FARMSLOT_NATIVE_STATE_DIR??null}));
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
    env,
    run(script, input = env) {
      return JSON.parse(
        execFileSync('bash', [path.join(repo, 'scripts', script)], {
          env: input,
          encoding: 'utf8',
        }),
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
  assert.equal(scripts['dev:node'], 'bash ../../scripts/dev-node.sh');
});
