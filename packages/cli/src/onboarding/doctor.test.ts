import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { captureHelperResultCheck, poolSection } from './doctor.js';
import { readPool } from './pool-config.js';
import { workspaceAt, type WorkspaceState } from './workspace.js';

test('capture check surfaces env-override provenance on success', () => {
  const check = captureHelperResultCheck(
    '/opt/bin/capture-helper',
    'env:SITEED_CAPTURE_HELPER_BIN',
    {
      status: 0,
      stdout: '',
      stderr: '',
      error: undefined,
    },
  );
  assert.equal(check.ok, true);
  assert.equal(check.warn, undefined);
  assert.equal(
    check.detail,
    '/opt/bin/capture-helper doctor passed (via SITEED_CAPTURE_HELPER_BIN)',
  );
});

test('capture check surfaces env-override provenance on failure', () => {
  const check = captureHelperResultCheck('/opt/bin/capture-helper', 'env:CAPTURE_HELPER_PATH', {
    status: 1,
    stdout: '',
    stderr: 'permission denied',
    error: undefined,
  });
  assert.equal(check.ok, true);
  assert.equal(check.warn, true);
  assert.equal(
    check.detail,
    '/opt/bin/capture-helper doctor failed (via CAPTURE_HELPER_PATH): permission denied',
  );
});

test('capture check prints PATH resolution plainly, no provenance suffix', () => {
  const pass = captureHelperResultCheck('capture-helper', 'PATH', {
    status: 0,
    stdout: '',
    stderr: '',
  });
  assert.equal(pass.detail, 'capture-helper doctor passed');
  const fail = captureHelperResultCheck('capture-helper', 'PATH', {
    status: 1,
    stdout: '',
    stderr: 'boom',
  });
  assert.equal(fail.detail, 'capture-helper doctor failed: boom');
});

test('doctor rejects dated/versioned slot paths without blocking structural teardown reads', (t) => {
  const ws = workspaceAt(mkdtempSync(join(tmpdir(), 'pool-doctor-')));
  t.after(() => rmSync(ws.root, { recursive: true, force: true }));
  mkdirSync(join(ws.farmslotDir, 'pool'), { recursive: true });
  const state: WorkspaceState = {
    schema_version: 1,
    source: { mode: 'local', path: ws.farmslotDir },
    machine: 'm',
    pool_file: 'pool/test.json',
    packs: {},
    pool_migrations: { applied: [] },
  };
  const rejected = [
    '/repos/mobile-8.14.0/source',
    '/repos/release/v8.16.0',
    '/repos/mobile-20260930',
    '/repos/mobile-2026-09-30/source',
    '/repos/mobile_2026_09_30',
    '/repos/2026/09/30/mobile',
  ];
  const stable = ['/repos/mobile-pixel6/source', '/repos/app-2', '/repos/device-21261FDF6001SP'];
  const file = join(ws.farmslotDir, state.pool_file);
  for (const repo of [...rejected, ...stable]) {
    const slot = { id: 'm-app-1', repo, session: 'app-1' };
    writeFileSync(
      file,
      JSON.stringify({ machine: 'm', host: 'localhost', ssh_user: 'u', slots: [slot] }),
    );
    assert.deepEqual(readPool(file).slots, [slot], 'teardown still reads structurally valid slots');
    const checks = poolSection(ws, state).checks;
    assert.equal(
      checks.every((check) => check.ok),
      stable.includes(repo),
      repo,
    );
    if (rejected.includes(repo)) {
      assert.ok(
        checks.some(
          (check) => !check.ok && check.detail?.includes(slot.id) && check.hint?.includes('stable'),
        ),
      );
    }
  }
});
