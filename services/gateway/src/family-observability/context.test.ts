import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  buildFollowUpLineage,
  buildFollowUpScopeContractSection,
  FOLLOW_UP_SCOPE_VERDICTS,
  getFamilyRecoveryLedger,
  materializeInheritedContext,
} from './context.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  const id = overrides.id ?? `run-${Math.random().toString(16).slice(2)}`;
  const ticketOrPr = overrides.ticketOrPr ?? 'PROJ-1';
  return {
    id,
    familyId: overrides.familyId ?? id,
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? ticketOrPr,
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode,
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr,
    app: overrides.app,
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    activeTaskFile: overrides.activeTaskFile,
    prNumber: overrides.prNumber,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-15T00:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: overrides.summary,
    reviewTier: overrides.reviewTier,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
  };
}

async function writeTaskArtifact(
  taskDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(taskDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

test('buildFollowUpLineage preserves canonical family identity', () => {
  const root = makeRun({
    id: 'root-run',
    ticketOrPr: 'PROJ-200',
    familyId: 'family-root',
    familyRootTicketOrPr: 'PROJ-200',
  });
  assert.deepEqual(buildFollowUpLineage(root), {
    familyId: 'family-root',
    parentRunId: 'root-run',
    familyRootTicketOrPr: 'PROJ-200',
  });
});

test('materializeInheritedContext skips standalone review-pr runs without parent lineage', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-standalone-'));
  const taskDir = path.join(baseDir, 'review-pr');
  const standalone = makeRun({
    id: 'review-standalone',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    familyId: 'review-standalone',
    parentRunId: null,
    familyRootTicketOrPr: 'owner/repo#42',
  });

  const manifest = await materializeInheritedContext(standalone, taskDir, [standalone]);
  assert.equal(manifest, null);
});

test('materializeInheritedContext prefers current task-local inherited assets', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-local-'));
  const rootTaskDir = path.join(baseDir, 'root');
  const currentTaskDir = path.join(baseDir, 'current');

  await writeTaskArtifact(rootTaskDir, 'TASK.md', '# Root task');
  await writeTaskArtifact(rootTaskDir, 'artifacts/report.md', 'root report');
  await writeTaskArtifact(currentTaskDir, 'inputs/inherited/report.md', 'local report');

  const root = makeRun({
    id: 'family-root',
    familyId: 'family-root',
    ticketOrPr: 'PROJ-200',
    taskFile: path.join(rootTaskDir, 'TASK.md'),
    summary: 'Original fix scope',
  });
  const followUp = makeRun({
    id: 'follow-up',
    flowType: 'pr-complete',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    taskFile: null,
    ticketOrPr: 'example-org/example-mobile#42',
  });

  const manifest = await materializeInheritedContext(followUp, currentTaskDir, [root, followUp]);
  const report = await readFile(path.join(currentTaskDir, 'inputs/inherited/report.md'), 'utf-8');

  assert.equal(report, 'local report');
  assert.equal(
    manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'report')?.resolutionTier,
    'task-local-inherited',
  );
});

test('materializeInheritedContext falls back parent -> root -> sibling and seeds recipe', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-order-'));
  const rootTaskDir = path.join(baseDir, 'root');
  const parentTaskDir = path.join(baseDir, 'parent');
  const siblingTaskDir = path.join(baseDir, 'sibling');
  const currentTaskDir = path.join(baseDir, 'current');

  await writeTaskArtifact(rootTaskDir, 'TASK.md', '# Root task');
  await writeTaskArtifact(rootTaskDir, 'artifacts/report.md', 'root report');
  await writeTaskArtifact(rootTaskDir, 'artifacts/recipe.json', '{"source":"root"}');
  await writeTaskArtifact(
    rootTaskDir,
    'artifacts/recipe-quality.json',
    '{"version":1,"verdict":"pass","compact":{"verdict":"PASS","reasons":["root"],"better_version_guidance":[]},"dimensions":{},"structural_findings":[],"contextual_findings":[],"suggested_recipe_delta":[],"training_fields":{},"meta":{"producer":"worker","fallback_used":false,"legacy_task":false,"artifact_required":true,"source_signals":["recipe-quality.json"]}}',
  );
  await writeTaskArtifact(parentTaskDir, 'TASK.md', '# Parent task');
  await writeTaskArtifact(parentTaskDir, 'artifacts/report.md', 'parent report');
  await writeTaskArtifact(siblingTaskDir, 'TASK.md', '# Sibling task');
  await writeTaskArtifact(siblingTaskDir, 'artifacts/report.md', 'sibling report');

  const root = makeRun({
    id: 'family-root',
    familyId: 'family-root',
    ticketOrPr: 'PROJ-300',
    taskFile: path.join(rootTaskDir, 'TASK.md'),
    summary: 'Original family scope',
  });
  const parent = makeRun({
    id: 'parent-run',
    flowType: 'review-pr',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#77',
    taskFile: path.join(parentTaskDir, 'TASK.md'),
    updatedAt: '2026-04-15T01:00:00.000Z',
  });
  const sibling = makeRun({
    id: 'sibling-run',
    flowType: 'merge-main',
    familyId: root.familyId,
    parentRunId: parent.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#77',
    taskFile: path.join(siblingTaskDir, 'TASK.md'),
    updatedAt: '2026-04-15T02:00:00.000Z',
  });
  const current = makeRun({
    id: 'current-run',
    flowType: 'pr-complete',
    familyId: root.familyId,
    parentRunId: parent.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#77',
    taskFile: null,
  });

  const manifest = await materializeInheritedContext(current, currentTaskDir, [
    root,
    parent,
    sibling,
    current,
  ]);
  const report = await readFile(path.join(currentTaskDir, 'inputs/inherited/report.md'), 'utf-8');
  const recipe = await readFile(path.join(currentTaskDir, 'artifacts/recipe.json'), 'utf-8');
  const recipeQuality = await readFile(
    path.join(currentTaskDir, 'inputs/inherited/recipe-quality.json'),
    'utf-8',
  );

  assert.equal(report, 'parent report');
  assert.equal(recipe, '{"source":"root"}');
  assert.match(recipeQuality, /"verdict":"pass"/);
  assert.equal(
    manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'report')?.resolutionTier,
    'parent-run-artifact',
  );
  assert.equal(
    manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'recipe')?.resolutionTier,
    'family-root-artifact',
  );
  assert.equal(
    manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'recipe-quality')
      ?.resolutionTier,
    'family-root-artifact',
  );
});

test('materializeInheritedContext prefers current-run artifacts before sibling fallback', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-current-'));
  const currentExistingTaskDir = path.join(baseDir, 'current-existing');
  const siblingNewerTaskDir = path.join(baseDir, 'sibling-newer');
  const siblingOlderTaskDir = path.join(baseDir, 'sibling-older');
  const currentTaskDir = path.join(baseDir, 'current-new');

  await writeTaskArtifact(currentExistingTaskDir, 'TASK.md', '# Current task');
  await writeTaskArtifact(currentExistingTaskDir, 'artifacts/report.md', 'current run report');
  await writeTaskArtifact(siblingOlderTaskDir, 'TASK.md', '# Sibling older');
  await writeTaskArtifact(siblingOlderTaskDir, 'artifacts/report.md', 'older sibling report');
  await writeTaskArtifact(siblingNewerTaskDir, 'TASK.md', '# Sibling newer');
  await writeTaskArtifact(siblingNewerTaskDir, 'artifacts/report.md', 'newer sibling report');

  const root = makeRun({
    id: 'family-root',
    familyId: 'family-root',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-350',
    taskFile: null,
    summary: 'Original scope',
  });
  const current = makeRun({
    id: 'current-run',
    flowType: 'review-pr',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#91',
    taskFile: path.join(currentExistingTaskDir, 'TASK.md'),
  });
  const olderSibling = makeRun({
    id: 'older-sibling',
    flowType: 'pr-complete',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#91',
    taskFile: path.join(siblingOlderTaskDir, 'TASK.md'),
    updatedAt: '2026-04-15T01:00:00.000Z',
  });
  const newerSibling = makeRun({
    id: 'newer-sibling',
    flowType: 'merge-main',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#91',
    taskFile: path.join(siblingNewerTaskDir, 'TASK.md'),
    updatedAt: '2026-04-15T02:00:00.000Z',
  });

  const manifest = await materializeInheritedContext(current, currentTaskDir, [
    root,
    current,
    olderSibling,
    newerSibling,
  ]);
  const report = await readFile(path.join(currentTaskDir, 'inputs/inherited/report.md'), 'utf-8');

  assert.equal(report, 'current run report');
  assert.equal(
    manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'report')?.resolutionTier,
    'current-run-artifact',
  );
});

test('materializeInheritedContext persists observable misses', async () => {
  const currentTaskDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-miss-'));
  const root = makeRun({
    id: 'family-root',
    familyId: 'family-root',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-400',
    taskFile: null,
    summary: 'Original scope',
  });
  const followUp = makeRun({
    id: 'follow-up',
    flowType: 'review-pr',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#88',
    taskFile: null,
  });

  const manifest = await materializeInheritedContext(followUp, currentTaskDir, [root, followUp]);
  const savedManifest = JSON.parse(
    await readFile(path.join(currentTaskDir, 'inputs/inherited-context.json'), 'utf-8'),
  );

  const reportEntry = manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'report');
  assert.equal(reportEntry?.status, 'missing');
  assert.ok((reportEntry?.attempts.length ?? 0) > 0);
  assert.equal(savedManifest.familyId, followUp.familyId);
});

test('materializeInheritedContext falls back to newest sibling when parent and root lack artifacts', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-sibling-'));
  const olderSiblingTaskDir = path.join(baseDir, 'older-sibling');
  const newerSiblingTaskDir = path.join(baseDir, 'newer-sibling');
  const currentTaskDir = path.join(baseDir, 'current');

  await writeTaskArtifact(olderSiblingTaskDir, 'TASK.md', '# Older sibling');
  await writeTaskArtifact(olderSiblingTaskDir, 'artifacts/report.md', 'older sibling report');
  await writeTaskArtifact(newerSiblingTaskDir, 'TASK.md', '# Newer sibling');
  await writeTaskArtifact(newerSiblingTaskDir, 'artifacts/report.md', 'newer sibling report');

  const root = makeRun({
    id: 'family-root',
    familyId: 'family-root',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-450',
    taskFile: null,
  });
  const current = makeRun({
    id: 'current-run',
    flowType: 'pr-complete',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#92',
    taskFile: null,
  });
  const olderSibling = makeRun({
    id: 'older-sibling',
    flowType: 'review-pr',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#92',
    taskFile: path.join(olderSiblingTaskDir, 'TASK.md'),
    updatedAt: '2026-04-15T01:00:00.000Z',
  });
  const newerSibling = makeRun({
    id: 'newer-sibling',
    flowType: 'merge-main',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    ticketOrPr: 'example-org/example-mobile#92',
    taskFile: path.join(newerSiblingTaskDir, 'TASK.md'),
    updatedAt: '2026-04-15T02:00:00.000Z',
  });

  const manifest = await materializeInheritedContext(current, currentTaskDir, [
    root,
    current,
    olderSibling,
    newerSibling,
  ]);
  const report = await readFile(path.join(currentTaskDir, 'inputs/inherited/report.md'), 'utf-8');

  assert.equal(report, 'newer sibling report');
  assert.equal(
    manifest?.inheritedArtifacts.find((entry) => entry.artifact === 'report')?.resolutionTier,
    'family-member-artifact',
  );
});

test('buildFollowUpScopeContractSection includes required scope verdicts', () => {
  const section = buildFollowUpScopeContractSection('tasks/pr-complete/pr-77-0415-1000', {
    version: 1,
    familyId: 'family-root',
    familyRootTicketOrPr: 'PROJ-500',
    parentRunId: 'parent-run',
    originalFamilyScopeSummary: 'Original family scope summary',
    currentTriggerSummary: 'Current trigger summary',
    requiredScopeVerdicts: [...FOLLOW_UP_SCOPE_VERDICTS],
    provenancePolicy: 'resolve-materialize-reference',
    inheritedArtifacts: [],
    generatedAt: '2026-04-15T00:00:00.000Z',
  });

  assert.match(section, /scopeVerdict/);
  assert.match(section, new RegExp(FOLLOW_UP_SCOPE_VERDICTS.join(' \\| ')));
  assert.match(section, /family-scope\.json/);
});

test('materializeInheritedContext inherits recipe-flows directory alongside recipe.json', async () => {
  // Regression for the family-chain subflow inheritance gap fixed 2026-04-30. A pr-complete
  // follow-up that resolves recipe.json from a parent fix-bug must also inherit the parent's
  // bundled subflows under artifacts/recipe-flows/, otherwise the recipe-runner fails at the
  // first `bundle/<name>` ref. Documented in ROADMAP-next §3.
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-flows-'));
  const parentTaskDir = path.join(baseDir, 'parent');
  const currentTaskDir = path.join(baseDir, 'current');

  await writeTaskArtifact(parentTaskDir, 'TASK.md', '# Parent task');
  await writeTaskArtifact(parentTaskDir, 'artifacts/recipe.json', '{"id":"orchestrator"}');
  await writeTaskArtifact(parentTaskDir, 'artifacts/recipe-flows/ac1.json', '{"id":"ac1"}');
  await writeTaskArtifact(parentTaskDir, 'artifacts/recipe-flows/ac2.json', '{"id":"ac2"}');

  const parent = makeRun({
    id: 'parent-fixbug',
    flowType: 'fix-bug',
    familyId: 'family-flows',
    ticketOrPr: 'example-org/example-browser#41949',
    taskFile: path.join(parentTaskDir, 'TASK.md'),
    summary: 'Parent fix-bug authored the recipe',
  });
  const current = makeRun({
    id: 'pr-complete-current',
    flowType: 'pr-complete',
    familyId: parent.familyId,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    ticketOrPr: parent.ticketOrPr,
    taskFile: null,
  });

  const manifest = await materializeInheritedContext(current, currentTaskDir, [parent, current]);
  const flowsEntry = manifest?.inheritedArtifacts.find(
    (entry) => entry.artifact === 'recipe-flows',
  );
  assert.equal(flowsEntry?.status, 'resolved');
  assert.equal(flowsEntry?.resolutionTier, 'parent-run-artifact');

  // Inherited dir present
  const ac1Inherited = await readFile(
    path.join(currentTaskDir, 'inputs/inherited/recipe-flows/ac1.json'),
    'utf-8',
  );
  const ac2Inherited = await readFile(
    path.join(currentTaskDir, 'inputs/inherited/recipe-flows/ac2.json'),
    'utf-8',
  );
  assert.equal(ac1Inherited, '{"id":"ac1"}');
  assert.equal(ac2Inherited, '{"id":"ac2"}');

  // Seeded into artifacts/ alongside recipe.json — the recipe-runner reads from artifacts/.
  const ac1Seeded = await readFile(
    path.join(currentTaskDir, 'artifacts/recipe-flows/ac1.json'),
    'utf-8',
  );
  const ac2Seeded = await readFile(
    path.join(currentTaskDir, 'artifacts/recipe-flows/ac2.json'),
    'utf-8',
  );
  assert.equal(ac1Seeded, '{"id":"ac1"}');
  assert.equal(ac2Seeded, '{"id":"ac2"}');
});

test('materializeInheritedContext carries inherited evidence package as latest-valid recipe run', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-evidence-package-'));
  const parentTaskDir = path.join(baseDir, 'parent');
  const currentTaskDir = path.join(baseDir, 'current');

  await writeTaskArtifact(parentTaskDir, 'TASK.md', '# Parent task');
  await writeTaskArtifact(parentTaskDir, 'artifacts/recipe.json', '{"id":"recipe"}');
  await writeTaskArtifact(parentTaskDir, 'artifacts/recipe-quality.json', '{"version":1}');
  await writeTaskArtifact(parentTaskDir, 'artifacts/report.md', '# Report');
  await writeTaskArtifact(
    parentTaskDir,
    'artifacts/evidence-manifest.json',
    JSON.stringify({
      version: 1,
      before_after_pairs: [
        { label: 'AC1', before: 'screenshots/before-ac1.png', after: 'after-ac1.png' },
      ],
      standalone: [{ label: 'Proof', file: 'evidence/proof.png' }],
      videos: { after: 'after.mp4', preferred: true, note: 'recording' },
    }),
  );
  await writeTaskArtifact(parentTaskDir, 'artifacts/screenshots/before-ac1.png', 'before');
  await writeTaskArtifact(parentTaskDir, 'artifacts/after-ac1.png', 'after');
  await writeTaskArtifact(parentTaskDir, 'artifacts/evidence/proof.png', 'proof');
  await writeTaskArtifact(parentTaskDir, 'artifacts/after.mp4', 'video');

  const parent = makeRun({
    id: 'parent-evidence',
    flowType: 'dev',
    familyId: 'family-evidence',
    ticketOrPr: 'PROJ-1043',
    taskFile: path.join(parentTaskDir, 'TASK.md'),
  });
  const current = makeRun({
    id: 'current-pr-complete',
    flowType: 'pr-complete',
    familyId: parent.familyId,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    ticketOrPr: 'example-org/example-browser#42641',
    taskFile: null,
  });

  const manifest = await materializeInheritedContext(current, currentTaskDir, [parent, current]);
  const packageEntry = manifest?.inheritedArtifacts.find(
    (entry) => entry.artifact === 'evidence-package',
  );

  assert.equal(packageEntry?.status, 'resolved');
  assert.equal(packageEntry?.resolutionTier, 'parent-run-artifact');
  assert.equal(packageEntry?.seededPath, 'recipe-runs/inherited-parent-evidence');

  const pointer = JSON.parse(
    await readFile(path.join(currentTaskDir, 'artifacts/latest-valid-recipe-run.json'), 'utf-8'),
  ) as { runId: string; relativeArtifactRoot: string; sourceRunId: string };
  assert.equal(pointer.runId, 'inherited-parent-evidence');
  assert.equal(pointer.relativeArtifactRoot, 'recipe-runs/inherited-parent-evidence');
  assert.equal(pointer.sourceRunId, parent.id);

  const packageRoot = path.join(currentTaskDir, 'artifacts/recipe-runs/inherited-parent-evidence');
  assert.equal(await readFile(path.join(packageRoot, 'recipe.json'), 'utf-8'), '{"id":"recipe"}');
  assert.equal(
    await readFile(path.join(packageRoot, 'evidence-manifest.json'), 'utf-8'),
    await readFile(path.join(parentTaskDir, 'artifacts/evidence-manifest.json'), 'utf-8'),
  );
  assert.equal(
    await readFile(path.join(packageRoot, 'screenshots/before-ac1.png'), 'utf-8'),
    'before',
  );
  assert.equal(await readFile(path.join(packageRoot, 'after-ac1.png'), 'utf-8'), 'after');
  assert.equal(await readFile(path.join(packageRoot, 'evidence/proof.png'), 'utf-8'), 'proof');
  assert.equal(await readFile(path.join(packageRoot, 'after.mp4'), 'utf-8'), 'video');
});

test('materializeInheritedContext records recipe-flows missing when parent has none', async () => {
  // Empty / absent recipe-flows dir on the parent must NOT resolve — an empty dir is a real
  // signal ("parent produced no subflows") and inheriting it would mask that upstream gap.
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'family-context-flows-empty-'));
  const parentTaskDir = path.join(baseDir, 'parent');
  const currentTaskDir = path.join(baseDir, 'current');

  await writeTaskArtifact(parentTaskDir, 'TASK.md', '# Parent');
  await writeTaskArtifact(parentTaskDir, 'artifacts/recipe.json', '{"id":"r"}');
  await mkdir(path.join(parentTaskDir, 'artifacts/recipe-flows'), { recursive: true });

  const parent = makeRun({
    id: 'parent-empty-flows',
    flowType: 'fix-bug',
    familyId: 'family-empty-flows',
    ticketOrPr: 'PROJ-1',
    taskFile: path.join(parentTaskDir, 'TASK.md'),
  });
  const current = makeRun({
    id: 'current-empty-flows',
    flowType: 'pr-complete',
    familyId: parent.familyId,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    ticketOrPr: parent.ticketOrPr,
    taskFile: null,
  });

  const manifest = await materializeInheritedContext(current, currentTaskDir, [parent, current]);
  const flowsEntry = manifest?.inheritedArtifacts.find(
    (entry) => entry.artifact === 'recipe-flows',
  );
  assert.equal(flowsEntry?.status, 'missing');
});

test('getFamilyRecoveryLedger derives replay attempts from family runs at read time', async (t) => {
  const familyId = `family-recovery-${process.pid}`;
  const older = createRun({
    flowType: 'fix-bug',
    project: 'farmslot',
    ticketOrPr: 'PROJ-31031',
    familyId,
  });
  const newer = createRun({
    flowType: 'fix-bug',
    project: 'farmslot',
    ticketOrPr: 'PROJ-31032',
    familyId,
  });
  updateRun(older.id, {
    status: 'failed',
    completedAt: '2026-05-12T00:00:00.000Z',
    recoveryAttempts: [
      {
        id: 'attempt-old',
        attempt: 1,
        stepName: 'prepare',
        startedAt: '2026-05-12T00:00:01.000Z',
        status: 'failed',
        triggeredBy: 'auto-recovery',
      },
    ],
  });
  updateRun(newer.id, {
    status: 'failed',
    completedAt: '2026-05-12T00:00:00.000Z',
    recoveryAttempts: [
      {
        id: 'attempt-new',
        attempt: 1,
        stepName: 'monitor',
        startedAt: '2026-05-12T00:00:02.000Z',
        status: 'started',
        triggeredBy: 'operator',
      },
    ],
  });
  t.after(async () => {
    for (const run of [older, newer]) if (getRun(run.id)) await deleteRun(run.id);
  });
  assert.deepEqual(
    getFamilyRecoveryLedger(familyId).map((attempt) => attempt.id),
    ['attempt-old', 'attempt-new'],
  );
});
