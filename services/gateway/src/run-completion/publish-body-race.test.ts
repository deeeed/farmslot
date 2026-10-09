import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ReadyGatePayload } from '@farmslot/protocol';

import type { ExecResult } from '../core/exec.js';
import { recordPublishedDescription } from '../run-engine/finalize-step.js';
import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import {
  assertReadyGatePackageInputsCurrent,
  buildPreparedDraftPrBody,
  renderCurrentDescription,
} from './orchestrator.js';
import { __setPrBodyRenderDepsForTest } from './pr-body-render.js';
import {
  assertLiveHeadMatchesPackage,
  computeReadyGatePackageHash,
  readyGateCurrentDescription,
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from './ready-gate-package.js';
import { makeRun } from './test-fixtures.js';

const PROSE = '## **Description**\n\nFix the order form.\n';
// The worker's own slot-side render: an older harness and a Command block.
const WORKER_BODY = [
  PROSE,
  '## **Validation Recipe**',
  '',
  '<details><summary>recipe.json (0 steps)</summary></details>',
  '',
  'Command:',
  '',
  '```bash',
  'mm-harness recipe run',
  '```',
  '',
].join('\n');
const gatewayRender = (prose: string) =>
  `${prose}\n## **Validation Recipe**\n\n<details><summary>recipe.json (18 nodes)</summary></details>\n`;

async function snapshotMirror(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    files[name] = await readFile(path.join(dir, name), 'utf-8');
  }
  return files;
}

async function makeTask() {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-publish-body-race-'));
  const artifactsDir = path.join(root, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const taskFile = path.join(root, 'task.md');
  await writeFile(taskFile, '# Task\n');
  await writeFile(path.join(artifactsDir, 'pr-description.md'), PROSE);
  await writeFile(path.join(artifactsDir, 'pr-body.md'), WORKER_BODY);
  // The slot is gone from the pool, so the template completion keeps the body as rendered.
  const run = makeRun({ flowType: 'dev', taskFile, slotId: 'no-such-slot', ticketOrPr: 'PROJ-1' });
  return { root, artifactsDir, run };
}

/**
 * A fake pack renderer: writes the gateway render to `--out`, or to the
 * mirror's `artifacts/pr-body.md` when no `--out` is given (the harness
 * default). On its first call a mirror refresh lands right after the render
 * and copies the worker's own `pr-body.md` back over the mirror file.
 */
function installRenderer(artifactsDir: string): string[] {
  const calls: string[] = [];
  let refreshPending = true;
  __setPrBodyRenderDepsForTest({
    resolveRenderer: async () => ({ command: 'mm-harness pr-body render' }),
    exec: async (command, opts) => {
      calls.push(command);
      const out =
        /--out '([^']+)'/.exec(command)?.[1] ?? path.join(opts.cwd, 'artifacts', 'pr-body.md');
      const prose = await readFile(path.join(opts.cwd, 'artifacts', 'pr-description.md'), 'utf-8');
      await writeFile(out, gatewayRender(prose));
      if (refreshPending) {
        refreshPending = false;
        await writeFile(path.join(artifactsDir, 'pr-body.md'), WORKER_BODY);
      }
      return { exitCode: 0, stdout: '{"status":"ok"}', stderr: '' } satisfies ExecResult;
    },
  });
  return calls;
}

function packageWith(draftTitle: string, draftBody: string) {
  return {
    id: 'pkg-race',
    packageHash: 'unused',
    artifactPath: 'artifacts/pr-package.json',
    branch: 'feature/race',
    headSha: 'abc123',
    diffStat: { files: 1, additions: 1, deletions: 0 },
    draftTitle,
    draftBody,
    evidenceManifest: [],
    selectedEvidenceKeys: [],
    validationSummaryPath: null,
    validationSummaryHash: null,
    reviewArtifactIds: [],
    dispatchMode: 'autonomous',
    gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'test' },
    publicationTarget: 'ready',
    publicationStatus: 'not_published',
    createdAt: '2026-10-09T00:00:00.000Z',
  } satisfies Parameters<typeof assertReadyGatePackageInputsCurrent>[1];
}

test('the package carries the gateway render even when a mirror refresh copies the worker pr-body.md', async () => {
  const { root, artifactsDir, run } = await makeTask();
  try {
    const calls = installRenderer(artifactsDir);
    // What prepareCompletionPackage builds after its mirror refresh.
    const draftBody = await buildPreparedDraftPrBody(run, null, [], 'main', {
      tolerateMissingSlot: true,
    });
    assert.equal(draftBody, gatewayRender(PROSE).trim());
    assert.doesNotMatch(draftBody, /0 steps|Command:/);

    const mirrorBefore = await snapshotMirror(artifactsDir);
    const published = await assertReadyGatePackageInputsCurrent(
      run,
      packageWith('feat: implement PROJ-1', draftBody),
    );
    assert.equal(published.draftBody, draftBody);
    assert.deepEqual(await snapshotMirror(artifactsDir), mirrorBefore);
    assert.equal(calls.length, 2);
    for (const command of calls) assert.match(command, / --out '[^']+' --json$/);
  } finally {
    __setPrBodyRenderDepsForTest(null);
    await rm(root, { recursive: true, force: true });
  }
});

test('a changed title and body do not block approval; the current render is published and the change logged', async () => {
  const { root, artifactsDir, run } = await makeTask();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  try {
    installRenderer(artifactsDir);
    const reviewed = packageWith('feat: an older title', 'An older reviewed body.');
    await writeFile(
      path.join(artifactsDir, 'pr-description.md'),
      '## **Description**\n\nEdited.\n',
    );
    const published = await assertReadyGatePackageInputsCurrent(run, reviewed);
    assert.deepEqual(published, {
      ...reviewed,
      draftTitle: 'feat: implement PROJ-1',
      draftBody: gatewayRender('## **Description**\n\nEdited.\n').trim(),
    });
    const logged = warnings.find((line) => /draft title, draft body changed/.test(line));
    assert.ok(logged, warnings.join('\n'));
    assert.match(logged, /body [0-9a-f]{12} -> [0-9a-f]{12}, title [0-9a-f]{12} -> [0-9a-f]{12}/);
    assert.match(logged, /publishing the current render/);
  } finally {
    console.warn = originalWarn;
    __setPrBodyRenderDepsForTest(null);
    await rm(root, { recursive: true, force: true });
  }
});

const REFRESH_STEP =
  /To refresh, click "Refresh current package" on the Ready gate or run: farmslot rpc run\.refreshPublishPackage '\{"runId":"run-1"\}'$/;

test('an evidence or validation mismatch still blocks, naming the input and the refresh step', async () => {
  const { root, artifactsDir, run } = await makeTask();
  try {
    installRenderer(artifactsDir);
    const draftBody = await buildPreparedDraftPrBody(run, null, [], 'main', {
      tolerateMissingSlot: true,
    });
    const stale = {
      ...packageWith('feat: implement PROJ-1', draftBody),
      evidenceManifest: [{ path: 'artifacts/after.png', purpose: 'screenshot', sha256: 'old' }],
      validationSummaryHash: 'old-hash',
    };
    await assert.rejects(assertReadyGatePackageInputsCurrent(run, stale), (error: Error) => {
      assert.match(
        error.message,
        /^Package changed; refresh package and re-review before publishing/,
      );
      assert.match(
        error.message,
        /evidence manifest: the evidence files differ from the reviewed package/,
      );
      assert.match(error.message, /validation summary hash: the validation summary differs/);
      assert.doesNotMatch(error.message, /draft (title|body)/);
      assert.match(error.message, REFRESH_STEP);
      return true;
    });
  } finally {
    __setPrBodyRenderDepsForTest(null);
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing evidence file and a moved HEAD still block with the refresh step', async () => {
  const { root, run } = await makeTask();
  try {
    const prPackage = {
      ...packageWith('feat: implement PROJ-1', 'Body'),
      evidenceManifest: [{ path: 'artifacts/after.png', purpose: 'screenshot' }],
      selectedEvidenceKeys: ['artifacts/after.png'],
    };
    await assert.rejects(
      verifyReadyGateSelectedEvidenceFiles(run, prPackage, prPackage.selectedEvidenceKeys),
      (error: Error) => {
        assert.match(error.message, /selected evidence file missing: artifacts\/after\.png/);
        assert.match(error.message, REFRESH_STEP);
        return true;
      },
    );
    assert.throws(
      () => assertLiveHeadMatchesPackage('run-1', 'abc123abc123abc1', 'def456def456def4'),
      (error: Error) => {
        assert.match(error.message, /approved HEAD abc123abc123 but live HEAD is def456def456/);
        assert.match(error.message, REFRESH_STEP);
        return true;
      },
    );
    assert.doesNotThrow(() => assertLiveHeadMatchesPackage('run-1', 'abc123', 'abc123'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the gate shows, publishes and records the current render while approval keeps the reviewed package hash', async (t) => {
  const { root, artifactsDir, run } = await makeTask();
  t.after(async () => {
    __setPrBodyRenderDepsForTest(null);
    await rm(root, { recursive: true, force: true });
  });
  installRenderer(artifactsDir);
  const withoutHash = packageWith('feat: implement PROJ-1', 'Reviewed body A.');
  const reviewed = { ...withoutHash, packageHash: computeReadyGatePackageHash(withoutHash) };
  const renderB = gatewayRender(PROSE).trim();

  // Gate open: the decision shows render B, not the reviewed body A.
  const shown = readyGateCurrentDescription(
    reviewed,
    await renderCurrentDescription(run, reviewed),
  );
  assert.deepEqual(shown, { title: 'feat: implement PROJ-1', body: renderB });

  // Approval publishes B; the reviewed package and its hash are what was approved.
  const published = await assertReadyGatePackageInputsCurrent(run, reviewed);
  assert.equal(published.draftBody, renderB);
  assert.equal(published.packageHash, reviewed.packageHash);
  verifyReadyGatePackageHash(reviewed);

  // After publication the gate decision records B.
  const stored = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1',
    runner: 'claude',
  });
  t.after(async () => deleteTestRunIfPresent(stored.id));
  const gatePayload = { kind: 'ready', prPackage: reviewed, currentDescription: shown };
  updateRun(stored.id, {
    decisions: [
      {
        id: 'gate-1',
        type: 'engine_human_gate',
        title: 'Ready',
        description: 'Ready',
        actions: [],
        createdAt: '2026-10-09T00:00:00.000Z',
        resolvedAt: '2026-10-09T00:01:00.000Z',
        resolvedAction: 'approve-publish',
        payload: gatePayload as unknown as ReadyGatePayload,
      },
    ],
  });
  recordPublishedDescription(stored.id, 'gate-1', published, '2026-10-09T00:02:00.000Z');
  const recorded = getRun(stored.id)!.decisions[0].payload as ReadyGatePayload;
  assert.deepEqual(recorded.currentDescription, {
    title: 'feat: implement PROJ-1',
    body: renderB,
    publishedAt: '2026-10-09T00:02:00.000Z',
  });
  assert.equal(recorded.prPackage?.packageHash, reviewed.packageHash);
  assert.equal(recorded.prPackage?.draftBody, 'Reviewed body A.');
});
