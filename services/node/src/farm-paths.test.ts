import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isNodeFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { nodeReportedFarmPaths } from './farm-paths.js';

test('node report uses its explicit standalone install directory with FARMSLOT_ROOT unset', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'node-installed-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'deploy');
  const runtime = path.join(install, 'node_modules/@farmslot/agent-runtime/scripts');
  mkdirSync(path.join(install, 'node_modules/@farmslot/protocol/dist/node'), { recursive: true });
  mkdirSync(runtime, { recursive: true });
  const report = nodeReportedFarmPaths(install, runtime, {
    FARMSLOT_HOME: path.join(root, 'home'),
  });
  assert.equal(isNodeFarmPaths(report), true);
  assert.equal(report.code.node, install);
  assert.equal(report.code.checkout, install);
  assert.equal(report.code.agentRuntimeScripts, runtime);
  assert.equal(report.pool, path.join(install, 'pool'));
  assert.equal(report.projects, path.join(install, 'projects'));
  assert.equal(report.state.runs, path.join(install, '.runs'));
  const development = nodeReportedFarmPaths(path.join(root, 'checkout/services/node'), runtime, {
    FARMSLOT_HOME: path.join(root, 'home'),
  });
  assert.equal(development.code.checkout, path.join(root, 'checkout'));
});
