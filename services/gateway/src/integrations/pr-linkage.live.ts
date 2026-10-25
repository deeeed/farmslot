// Opt-in proof against a real, unrelated closed PR. Only the isolated run/cache are writable.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Methods, type RunRehydratePrNumberResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

await import('../runtime/mock-pty.test-support.js');

test('authenticated PR rehydration ignores a real historical closed PR on a reused branch', async (t) => {
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
  const { createRun, getRun } = await import('../runs/store.js');
  const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    devInteractiveProfile: 'lightweight',
    project,
    ticketOrPr: 'PR-LINKAGE-PROOF',
    branch,
  });
  const connection = await fixture.client.connect();
  try {
    const result = await connection.call<RunRehydratePrNumberResult>(
      Methods.RUN_REHYDRATE_PR_NUMBER,
      { runId: run.id },
      { timeoutMs: 120_000 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'still no PR on branch');
    assert.equal(getRun(run.id)?.prNumber, undefined);
    assert.deepEqual(getRun(run.id)?.prPublications ?? [], []);
    t.diagnostic(JSON.stringify({ historical, result, runId: run.id, bound: false }));
  } finally {
    connection.close();
    await deleteTestRunIfPresent(run.id);
  }
});
