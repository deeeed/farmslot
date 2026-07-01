import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadCheckoutEnv, parseEnvFile } from './env-file.js';

test('parseEnvFile handles comments, quotes, export, and tilde', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'GATEWAY_PORT=7801',
      'export GW_URL=ws://localhost:7801',
      'FARMSLOT_HOME=~/.farmslot-dev',
      'QUOTED="a b"',
      "SINGLE='x'",
      'not a valid line',
      '=novalue',
    ].join('\n'),
  );
  assert.equal(parsed.GATEWAY_PORT, '7801');
  assert.equal(parsed.GW_URL, 'ws://localhost:7801');
  assert.equal(parsed.FARMSLOT_HOME, '~/.farmslot-dev'); // left literal — the resolver expands ~
  assert.equal(parsed.QUOTED, 'a b');
  assert.equal(parsed.SINGLE, 'x');
  assert.equal(parsed['not a valid line'], undefined);
});

test('loadCheckoutEnv fills from .env.ports but never overrides the shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  writeFileSync(
    join(root, '.env.ports'),
    'FARMSLOT_HOME=~/.farmslot-dev\nGW_URL=ws://localhost:7801\n',
  );
  try {
    const env: NodeJS.ProcessEnv = { GW_URL: 'ws://localhost:9999' }; // shell already set GW_URL
    loadCheckoutEnv(root, env);
    assert.equal(env.FARMSLOT_HOME, '~/.farmslot-dev'); // filled from file
    assert.equal(env.GW_URL, 'ws://localhost:9999'); // shell wins, not overridden
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.env.ports takes precedence over .env (loaded first, non-override)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  writeFileSync(join(root, '.env.ports'), 'FOO=from-ports\n');
  writeFileSync(join(root, '.env'), 'FOO=from-env\nBAR=only-in-env\n');
  try {
    const env: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, env);
    assert.equal(env.FOO, 'from-ports');
    assert.equal(env.BAR, 'only-in-env');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCheckoutEnv is a no-op when no env files exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-envfile-'));
  try {
    const env: NodeJS.ProcessEnv = {};
    loadCheckoutEnv(root, env);
    assert.deepEqual(env, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
