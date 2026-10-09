import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ReadyGatePayload } from '@farmslot/protocol';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import type { ExecResult } from '../core/exec.js';
import { farmslotRoot } from '../fleet/state.js';
import { recordPublishedDescription } from '../run-engine/finalize-step.js';
import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import {
  assertReadyGatePackageInputsCurrent,
  buildPreparedDraftPrBody,
  publishCompletionPackage,
  renderCurrentDescription,
} from './orchestrator.js';
import { __setPrBodyRenderDepsForTest } from './pr-body-render.js';
import { postProcessPRBody } from './publication-artifacts.js';
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

/**
 * A local `gh` first on PATH: it copies every posted PR body to `capture`,
 * logs each call, answers `gh api` with a 404 and refuses anything but
 * `pr edit`. The test asserts it is the `gh` the gateway resolves, so no call
 * can reach GitHub.
 */
async function installGhCapture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-gh-capture-'));
  const capture = path.join(dir, 'posted-body.md');
  const calls = path.join(dir, 'calls.log');
  const gh = path.join(dir, 'gh');
  await writeFile(
    gh,
    [
      '#!/bin/sh',
      `echo "$*" >> '${calls}'`,
      `if [ "$1" = api ]; then printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{}'; exit 0; fi`,
      'if [ "$1" != pr ] || [ "$2" != edit ]; then exit 97; fi',
      'while [ "$#" -gt 0 ]; do',
      `  if [ "$1" = --body-file ]; then cp "$2" '${capture}'; exit $?; fi`,
      '  shift',
      'done',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(gh, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  t.after(async () => {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });
  const resolved = execFileSync('sh', ['-c', 'command -v gh'], { encoding: 'utf-8' }).trim();
  assert.equal(resolved, gh);
  return { capture, calls };
}

function storedRunWithGate(t: import('node:test').TestContext, payload: unknown) {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1',
    runner: 'claude',
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
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
        payload: payload as ReadyGatePayload,
      },
    ],
  });
  return run;
}

test('the recorded description is the body publication posted, without deselected evidence', async (t) => {
  const { capture } = await installGhCapture(t);
  const reviewed = packageWith(
    'feat: implement PROJ-1',
    [
      '## **Description**',
      '',
      'Fix the order form.',
      '',
      '## **Screenshots/Recordings**',
      '',
      '<img src="artifacts/orders.png" alt="Orders" /> <img src="artifacts/activity.png" alt="Activity" />',
      '',
    ].join('\n'),
  );
  const run = storedRunWithGate(t, { kind: 'ready', prPackage: reviewed });
  // The operator selected only the Orders screenshot.
  const posted = await postProcessPRBody(
    getRun(run.id)!,
    'owner/repo',
    4242,
    new Map([
      ['artifacts/orders.png', 'https://example.invalid/orders.png'],
      ['artifacts/activity.png', 'https://example.invalid/activity.png'],
    ]),
    ['artifacts/orders.png'],
    {
      failOnError: true,
      baseBody: reviewed.draftBody,
      evidenceManifest: {
        version: 1,
        preferred_mode: 'screenshots',
        standalone: [
          { label: 'Orders', file: 'orders.png' },
          { label: 'Activity', file: 'activity.png' },
        ],
      },
    },
  );
  const sent = await readFile(capture, 'utf-8');
  assert.equal(posted, sent);
  assert.match(sent, /orders\.png/);
  assert.doesNotMatch(sent, /activity\.png|Activity/);

  recordPublishedDescription(
    run.id,
    'gate-1',
    { draftTitle: reviewed.draftTitle, draftBody: posted! },
    '2026-10-09T00:02:00.000Z',
  );
  const recorded = getRun(run.id)!.decisions[0].payload as ReadyGatePayload;
  assert.equal(recorded.currentDescription?.body, sent);
  assert.equal(recorded.prPackage?.draftBody, reviewed.draftBody);
});

test('a publish retry that posts nothing leaves the recorded description and its time alone', async (t) => {
  const { capture } = await installGhCapture(t);
  const reviewed = packageWith('feat: implement PROJ-1', 'Reviewed body A.');
  const record = {
    title: 'feat: implement PROJ-1',
    body: 'Posted body.',
    publishedAt: '2026-10-09T00:02:00.000Z',
  };
  const run = storedRunWithGate(t, {
    kind: 'ready',
    prPackage: reviewed,
    currentDescription: record,
  });
  updateRun(run.id, {
    prNumber: 4242,
    engineState: { publishGate: { publicationStatus: 'published_ready' } },
  });

  // Finalize re-runs after a prose edit: the PR is already published.
  const result = await publishCompletionPackage(run.id, {
    ...reviewed,
    draftBody: 'Reviewed body A.\n\nEdited after publication.\n',
  });
  assert.equal(result.bodyPostProcessed, false);
  assert.equal(result.publishedDescription, undefined);
  recordPublishedDescription(
    run.id,
    'gate-1',
    result.publishedDescription,
    '2026-10-09T00:03:00.000Z',
  );
  const payload = getRun(run.id)!.decisions[0].payload as ReadyGatePayload;
  assert.deepEqual(payload.currentDescription, record);
  assert.equal(payload.prPackage?.packageHash, reviewed.packageHash);
  await assert.rejects(readFile(capture, 'utf-8'), { code: 'ENOENT' });
});

test('a successful publication hands the posted body to the published-description record', async (t) => {
  const { capture, calls } = await installGhCapture(t);
  const project = `.publish-body-test-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name: project, default_branch: 'main', ci: { repo: 'owner/repo' } }),
  );
  invalidateProjectVarsCache(project);
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
    invalidateProjectVarsCache(project);
  });
  // Publication ticks the author checklist, so what it posts is not the approved body.
  const reviewed = packageWith(
    'feat: implement PROJ-1',
    '## **Description**\n\nFix the order form.\n\n- [ ] I tested this\n',
  );
  const run = storedRunWithGate(t, { kind: 'ready', prPackage: reviewed });
  updateRun(run.id, { project, prNumber: 4242 });

  const result = await publishCompletionPackage(run.id, reviewed, { publicationTarget: 'draft' });
  const sent = await readFile(capture, 'utf-8');
  assert.match(sent, /- \[x\] I tested this/);
  assert.deepEqual(result.publishedDescription, {
    draftTitle: 'feat: implement PROJ-1',
    draftBody: sent,
  });
  // As finalize does with the result.
  recordPublishedDescription(
    run.id,
    'gate-1',
    result.publishedDescription,
    '2026-10-09T00:02:00.000Z',
  );
  const payload = getRun(run.id)!.decisions[0].payload as ReadyGatePayload;
  assert.deepEqual(payload.currentDescription, {
    title: 'feat: implement PROJ-1',
    body: sent,
    publishedAt: '2026-10-09T00:02:00.000Z',
  });
  assert.equal(payload.prPackage?.packageHash, reviewed.packageHash);
  const log = await readFile(calls, 'utf-8');
  assert.match(log, /^pr edit 4242 --repo owner\/repo --body-file /m);
  assert.match(log, /^pr edit 4242 --repo owner\/repo --title feat: implement PROJ-1$/m);
});
