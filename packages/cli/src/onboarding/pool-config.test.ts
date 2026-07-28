import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  allocatePort,
  backfillMetroPort,
  CDP_PORT_BLOCK_START,
  defaultDevServerResource,
  defaultResources,
  generatePool,
  type PoolConfig,
  poolFileName,
  PORT_BLOCK_START,
  registerSlot,
  validatePoolConfig,
} from './pool-config.js';

function pool(slots: PoolConfig['slots'] = []): PoolConfig {
  return { machine: 'm', host: 'localhost', ssh_user: 'u', slots };
}

test('validatePoolConfig accepts a minimal valid pool', () => {
  assert.deepEqual(validatePoolConfig(pool()), []);
  assert.deepEqual(
    validatePoolConfig(pool([{ id: 'm-app-1', repo: '/tmp/r', session: 'app-1' }])),
    [],
  );
});

test('validatePoolConfig reports actionable errors', () => {
  assert.deepEqual(validatePoolConfig('nope'), ['pool config must be a JSON object']);
  const errors = validatePoolConfig({ machine: '', slots: [{ id: 'a', repo: '', session: 's' }] });
  assert.ok(errors.some((e) => e.includes(`'machine'`)));
  assert.ok(errors.some((e) => e.includes(`'host'`)));
  assert.ok(errors.some((e) => e.includes(`'ssh_user'`)));
  assert.ok(errors.some((e) => e.includes(`slots[0]: 'repo'`)));
});

test('validatePoolConfig rejects duplicate slot ids', () => {
  const errors = validatePoolConfig(
    pool([
      { id: 'm-app-1', repo: '/a', session: 's1' },
      { id: 'm-app-1', repo: '/b', session: 's2' },
    ]),
  );
  assert.ok(errors.some((e) => e.includes('duplicate slot id')));
});

test('generatePool produces a schema-valid zero-slot pool with detected runners', () => {
  const generated = generatePool({
    machine: 'host-a',
    os: 'darwin',
    sshUser: 'dev',
    runnerPaths: { claude: '/usr/local/bin/claude', grok: '/Users/example/.grok/bin/grok' },
  });
  assert.deepEqual(validatePoolConfig(generated), []);
  assert.equal(generated.machine, 'host-a');
  assert.equal(generated.claude_path, '/usr/local/bin/claude');
  assert.equal(generated.grok_path, '/Users/example/.grok/bin/grok');
  assert.equal(generated.codex_path, undefined);
  assert.equal(generated.slots.length, 0);
  assert.equal(generated.schema_version! >= 1, true);
});

test('allocatePort starts at the high block and skips taken ports', () => {
  const p = pool([
    { id: 'm-a-1', repo: '/a', session: 'a-1', resources: { 'dev-server': { port: 9300 } } },
    { id: 'm-a-2', repo: '/b', session: 'a-2', resources: { 'dev-server': { port: 9301 } } },
  ]);
  assert.equal(allocatePort(pool()), PORT_BLOCK_START);
  assert.equal(allocatePort(pool(), 1), PORT_BLOCK_START);
  assert.equal(allocatePort(p), 9302);
  assert.throws(() => allocatePort(pool(), 65_536), /at or below 65535/);
});

test('defaultDevServerResource allocates distinct gateway and Metro ports', () => {
  assert.deepEqual(defaultDevServerResource(pool()), {
    port: PORT_BLOCK_START,
    metro_port: PORT_BLOCK_START + 1,
  });
});

test('backfillMetroPort preserves the gateway port and allocates a distinct port', () => {
  const slot = {
    id: 'm-a-1',
    repo: '/a',
    session: 'a-1',
    resources: { 'dev-server': { port: 9300 } },
  };
  const p = pool([slot]);
  assert.equal(backfillMetroPort(p, slot), 9301);
  assert.deepEqual(slot.resources['dev-server'], { port: 9300, metro_port: 9301 });
  assert.equal(backfillMetroPort(p, slot), null);
});

test('backfillMetroPort repairs invalid explicit values', () => {
  const slot = {
    id: 'm-a-1',
    repo: '/a',
    session: 'a-1',
    resources: { 'dev-server': { port: 9300, metro_port: 70_000 } },
  };
  const p = pool([slot]);
  assert.equal(backfillMetroPort(p, slot), 9301);
});

test('defaultResources gives platform slots their device/browser resource', () => {
  assert.deepEqual(defaultResources('ios', 'mm', 2, pool()), {
    'ios-sim': { simulator: 'mm-2', headless: true },
  });
  assert.deepEqual(defaultResources('android', 'mm', 1, pool()), {
    'android-emu': { avd: 'mm-1' },
  });
  assert.deepEqual(defaultResources('chrome-extension', 'mme', 1, pool()), {
    browser: { cdp_port: CDP_PORT_BLOCK_START },
  });
  assert.deepEqual(defaultResources('cli', 'core', 1, pool()), {});
});

test('defaultResources allocates cdp ports clear of taken ones', () => {
  const p = pool([
    { id: 'm-x-1', repo: '/a', session: 'x-1', resources: { browser: { cdp_port: 9500 } } },
  ]);
  assert.deepEqual(defaultResources('browser', 'x', 2, p), { browser: { cdp_port: 9501 } });
});

test('defaultResources cdp allocation skips ports taken by other resource blocks', () => {
  const p = pool([
    { id: 'm-y-1', repo: '/a', session: 'y-1', resources: { 'dev-server': { port: 9500 } } },
  ]);
  assert.deepEqual(defaultResources('chrome-extension', 'y', 1, p), {
    browser: { cdp_port: 9501 },
  });
});

test('registerSlot never clobbers an existing slot', () => {
  const p = pool([{ id: 'm-a-1', repo: '/user-edited', session: 'a-1' }]);
  const added = registerSlot(p, { id: 'm-a-1', repo: '/new', session: 'a-1' });
  assert.equal(added, false);
  assert.equal(p.slots[0].repo, '/user-edited');
  assert.equal(registerSlot(p, { id: 'm-a-2', repo: '/b', session: 'a-2' }), true);
  assert.equal(p.slots.length, 2);
});

test('poolFileName avoids colliding with an existing host pool file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-pool-'));
  assert.equal(poolFileName('myhost', dir), 'myhost.json');
  writeFileSync(join(dir, 'myhost.json'), '{}');
  assert.equal(poolFileName('myhost', dir), 'myhost-onboard.json');
  assert.equal(poolFileName('myhost', null), 'myhost.json');
});
