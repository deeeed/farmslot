import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { remapRemoteFarmRefs } from '../node-support/remote-command.js';

import { getRunnerDefinition } from './registry.js';
import { makeVars } from './test-fixtures.js';

for (const scenario of ['bundle', 'no-support', 'missing-extension'] as const) {
  test(`pi catalog command without a slot install: ${scenario}`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'catalog-support-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo's space");
    const support = path.join(root, 'support', 'a'.repeat(64));
    const runners = path.join(support, 'scripts/runners');
    const binary = path.join(root, "pi's binary");
    mkdirSync(repo);
    writeFileSync(binary, '#!/bin/sh\nprintf \'["native"]\\n\'\n', { mode: 0o755 });
    if (scenario !== 'no-support') {
      mkdirSync(runners, { recursive: true });
      writeFileSync(
        path.join(runners, 'pi-farmslot-providers.mjs'),
        'console.log(JSON.stringify(process.argv.slice(2)));',
      );
      if (scenario === 'bundle')
        writeFileSync(path.join(runners, 'pi-farmslot-observability.ts'), '// Synthetic extension');
    } else {
      // A stale slot install must not substitute for absent node support.
      const slotBin = path.join(repo, '.agent/.observability/bin');
      mkdirSync(slotBin, { recursive: true });
      writeFileSync(path.join(slotBin, 'pi-farmslot-observability.ts'), '// Stale fixture');
    }
    const source = getRunnerDefinition('pi').modelCatalog;
    assert.ok(source && 'nodeCommand' in source && source.buildCommand);
    const vars = makeVars({
      host: 'remote-fixture.local',
      machine: 'remote-fixture',
      remoteRepo: repo,
    });
    const command = source.buildCommand(vars, binary);
    const mapped = remapRemoteFarmRefs(command, support, ['scripts']);
    const result = spawnSync('/bin/bash', ['-c', mapped], {
      env: { PATH: process.env.PATH, HOME: root },
      encoding: 'utf8',
    });
    if (scenario === 'missing-extension') {
      assert.equal(result.status, 78);
      assert.match(result.stderr, /PI_MODEL_CATALOG_EXTENSION_MISSING/);
      assert.equal(result.stdout, '');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(result.stdout),
        scenario === 'bundle'
          ? ['--list-models', binary, '-e', path.join(runners, 'pi-farmslot-observability.ts')]
          : ['native'],
      );
    }
  });
}
