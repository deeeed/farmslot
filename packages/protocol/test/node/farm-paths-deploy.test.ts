import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  legacyRemoteFarmPaths,
  parseFarmInstanceConfig,
  resolveFarmPaths,
} from '../../src/node/farm-paths.js';

test('deployment resolves a validated target marker without reading a same-named local home', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'farm-target-marker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/instance.json'), 'invalid local marker');
  const config = parseFarmInstanceConfig(
    { layout: 2, name: 'target', ports: { gateway: 8817 } },
    'remote/config/instance.json',
  );
  const paths = resolveFarmPaths({ role: 'node', home: root, env: {}, instanceConfig: config });
  assert.equal(paths.code.node, path.join(root, 'code/node'));
  assert.equal(paths.code.cli, path.join(root, 'code/cli'));
  assert.equal(paths.instance, 'target');
  assert.equal(config.ports?.gateway, 8817);
  assert.throws(
    () => parseFarmInstanceConfig({ layout: 2, ports: { gateway: 65536 } }, 'bad port'),
    /Invalid farm instance config/,
  );
  const legacy = resolveFarmPaths({
    role: 'node',
    home: root,
    env: {},
    checkoutRoot: '/target/farmslot-node-dev',
    instanceConfig: null,
  });
  assert.equal(legacy.code.node, '/target/farmslot-node-dev');
  assert.throws(
    () => parseFarmInstanceConfig({ layout: 3 }, 'target marker'),
    /Invalid farm instance config: target marker/,
  );
});

test('old-node roots retain explicit machine environment and discovered helper locations', () => {
  const paths = legacyRemoteFarmPaths(
    {
      FARMSLOT_HOME: '/node/home',
      FARMSLOT_POOL_DIR: '/node/pool',
      FARMSLOT_PROJECTS_DIR: '/node/packs',
      FARMSLOT_RUNS_DIR: '/node/runs',
    },
    '/node/install',
    '/node/resolved-helpers',
  );
  assert.equal(paths.home, '/node/home');
  assert.equal(paths.pool, '/node/pool');
  assert.equal(paths.projects, '/node/packs');
  assert.equal(paths.state.runs, '/node/runs');
  assert.equal(paths.code.agentRuntimeScripts, '/node/resolved-helpers');
});
