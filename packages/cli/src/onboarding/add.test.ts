import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AddError, expandHookTemplate, findMissingState } from './add.js';
import type { PackJson } from './pack.js';

test('expandHookTemplate substitutes slot vars', () => {
  assert.equal(
    expandHookTemplate('node scripts/build.mjs --port {{port}} --slot {{slot_id}}', {
      port: 9300,
      slot_id: 'm-app-1',
    }),
    'node scripts/build.mjs --port 9300 --slot m-app-1',
  );
});

test('expandHookTemplate fails hard on unknown variables', () => {
  assert.throws(
    () => expandHookTemplate('run --device {{adb_serial}}', { port: 1 }),
    (err: unknown) =>
      err instanceof AddError && /unknown variable \{\{adb_serial\}\}/.test(err.message),
  );
  // Uppercase/digit placeholders must fail hard too, not pass through silently.
  assert.throws(() => expandHookTemplate('run --port {{PORT}}', { port: 1 }), AddError);
});

test('findMissingState: complete state is a true no-op, missing pieces escalate', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-noop-'));
  const ws = { farmslotDir: join(root, 'farmslot'), reposDir: join(root, 'repos') };
  const pack: PackJson = {
    name: 'p',
    projects: [{ dir: 'projects/app-farm', platform: 'cli', slots: 1 }],
  };
  const pool = { machine: 'm', slots: [{ id: 'm-app-1' }] };

  mkdirSync(join(ws.farmslotDir, 'projects', 'app-farm'), { recursive: true });
  writeFileSync(join(ws.farmslotDir, 'projects', 'app-farm', 'project.json'), '{}');
  mkdirSync(join(ws.reposDir, 'app-1', '.git'), { recursive: true });

  // Everything in place → verify-only no-op: no lifecycle steps would rerun.
  assert.deepEqual(findMissingState(pack, pool, ws), []);

  // Missing slot repo → escalates to repair.
  rmSync(join(ws.reposDir, 'app-1'), { recursive: true });
  assert.deepEqual(findMissingState(pack, pool, ws), ['repo app-1 missing']);

  // Missing pool slot and project registration are reported too.
  assert.equal(findMissingState(pack, { machine: 'm', slots: [] }, ws).length, 2);
});
