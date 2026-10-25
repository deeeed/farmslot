// Opt-in proof against a real, unrelated closed PR. Only the isolated run/cache are writable.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Methods, type RunInteractiveDevResolveResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

await import('../runtime/mock-pty.test-support.js');

test('authenticated discovery ignores a saved historical closed PR on a reused branch', async (t) => {
  const repository = process.env.FARMSLOT_PR_LINKAGE_PROOF_REPO;
  const branch = process.env.FARMSLOT_PR_LINKAGE_PROOF_BRANCH;
  const number = Number(process.env.FARMSLOT_PR_LINKAGE_PROOF_NUMBER);
  assert.ok(repository && branch && Number.isInteger(number) && number > 0, 'Set proof PR inputs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr-linkage-proof-'));
  for (const file of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(new URL(`../../../../${file}`, import.meta.url), path.join(root, file));
  }
  process.env.FARMSLOT_DIR = root;
  const fixture = await createNativeProofFixture(t, root);
  const project = 'pr-linkage-proof';
  const projectRoot = path.join(root, 'projects', project);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, 'project.json'),
    JSON.stringify({ ci: { repo: repository } }),
  );
  const { ghRequest } = await import('./github-client.js');
  const { stdout } = await ghRequest(
    [
      'pr',
      'view',
      String(number),
      '--repo',
      repository,
      '--json',
      'number,state,mergedAt,headRefName,headRefOid',
    ],
    { force: true },
  );
  const historical = JSON.parse(stdout);
  assert.equal(historical.state, 'CLOSED');
  assert.equal(historical.mergedAt, null);
  assert.equal(historical.headRefName, branch);
  const { createRun, getRun, updateRun } = await import('../runs/store.js');
  const { getBinding } = await import('./github-bindings-cache.js');
  const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    devInteractiveProfile: 'lightweight',
    project,
    ticketOrPr: 'PROJ-1',
    branch,
  });
  const connection = await fixture.client.connect();
  try {
    updateRun(run.id, { prNumber: number });
    const before = structuredClone(getRun(run.id)!);
    const saved = await connection.call<RunInteractiveDevResolveResult>(
      Methods.RUN_INTERACTIVE_DEV_RESOLVE,
      { runId: run.id, action: 'detect-pr-and-ci-watch' },
      { timeoutMs: 120_000 },
    );
    assert.equal(saved.ok, false);
    assert.equal(saved.reason, 'no PR found on branch');
    assert.equal(saved.needsPr, true);
    assert.equal(getBinding(branch, repository), null);
    assert.deepEqual(getRun(run.id)?.prPublications ?? [], []);
    assert.deepEqual(getRun(run.id)?.steps, before.steps);
    assert.equal(getRun(run.id)?.status, before.status);
    t.diagnostic(
      JSON.stringify({
        historical,
        result: {
          ok: saved.ok,
          reason: saved.reason,
          needsPr: saved.needsPr,
        },
        runId: run.id,
        stepped: false,
      }),
    );
  } finally {
    t.diagnostic(JSON.stringify({ cachedBinding: getBinding(branch, repository) }));
    connection.close();
    await deleteTestRunIfPresent(run.id);
  }
});
