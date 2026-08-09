import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { ImprovementDiffPayload, Run, RunDecision } from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';
import { runResolveDecision } from '../methods/run.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { applyImprovement } from './improvement-engine.js';

// Scratch project inside projects/ (gitignored by the root repo). Applies
// force-add files to the root index, so cleanup must unstage them too.
const TEST_PROJECT = `.improve-apply-test-${process.pid}`;
const TEST_PROJECT_DIR = path.join(farmslotRoot, 'projects', TEST_PROJECT);

function setupProject(options: { validateHook?: boolean } = {}): void {
  mkdirSync(path.join(TEST_PROJECT_DIR, 'fixtures'), { recursive: true });
  // Cheapest possible validation hook so applies resolve fast in tests; tests
  // for the markdown-only fallback skip omit it.
  writeFileSync(
    path.join(TEST_PROJECT_DIR, 'project.json'),
    options.validateHook === false ? '{}\n' : '{"hooks":{"validate":"true"}}\n',
  );
}

function teardownProject(): void {
  try {
    execFileSync('git', ['reset', '-q', '--', `projects/${TEST_PROJECT}`], { cwd: farmslotRoot });
  } catch {
    // Nothing was staged for this path — reset has nothing to do.
  }
  rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
}

function seedImprovementRun(changes: ImprovementDiffPayload['proposedChanges']): {
  run: Run;
  decisionId: string;
} {
  const run = createRun({
    flowType: 'fix-bug',
    project: TEST_PROJECT,
    ticketOrPr: `IMPROVE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  const decision: RunDecision = {
    id: `imp-${run.id}-test`,
    type: 'improvement',
    title: 'Template improvement proposed',
    description: 'test',
    actions: [
      { id: 'apply', label: 'Apply', style: 'primary' },
      { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
    ],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'improvement',
      learningContent: 'test learning',
      proposedChanges: changes,
      rationale: 'test rationale',
      sourceRunId: run.id,
      project: TEST_PROJECT,
      analysisStatus: 'completed',
    },
  };
  updateRun(run.id, { decisions: [decision] });
  return { run, decisionId: decision.id };
}

async function cleanupRun(runId: string): Promise<void> {
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('apply writes an anchored change and resolves the decision', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  writeFileSync(path.join(farmslotRoot, rel), 'old content\n');
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: 'old content\n', after: 'old content\nnew guidance\n' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 1);
  assert.equal(result.validationPassed, true);
  assert.equal(result.refused, undefined);
  assert.equal(
    await readFile(path.join(farmslotRoot, rel), 'utf-8'),
    'old content\nnew guidance\n',
  );
  assert.equal(
    getRun(run.id)?.decisions.find((d) => d.id === decisionId)?.resolvedAction,
    'applied',
  );
  assert.equal(
    existsSync(path.join(TEST_PROJECT_DIR, 'learnings', 'LEARNINGS.md')),
    false,
    'apply must not auto-append to the human-curated LEARNINGS.md',
  );
});

test('apply refuses a stale anchor and leaves the file and card untouched', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  // Disk moved on after the card was proposed (another card / human edit).
  writeFileSync(path.join(farmslotRoot, rel), 'content changed by someone else\n');
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: 'old content\n', after: 'clobbering full-file snapshot\n' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.refused, [{ filePath: rel, reason: 'stale-anchor' }]);
  assert.equal(
    await readFile(path.join(farmslotRoot, rel), 'utf-8'),
    'content changed by someone else\n',
  );
  assert.equal(
    getRun(run.id)?.decisions.find((d) => d.id === decisionId)?.resolvedAction,
    undefined,
    'card must stay pending',
  );
});

test('apply refuses a suspicious shrink (truncated LLM payload signature)', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  const before = `# Guide\n${'a real guidance line that matters\n'.repeat(40)}`;
  writeFileSync(path.join(farmslotRoot, rel), before);
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before, after: '# Guide\ntruncat' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.refused, [{ filePath: rel, reason: 'suspicious-shrink' }]);
  assert.equal(await readFile(path.join(farmslotRoot, rel), 'utf-8'), before);
});

test('apply creates a new file when the card declares an empty before', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/new-doc.md`;
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: '', after: 'brand new guidance\n' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 1);
  assert.equal(await readFile(path.join(farmslotRoot, rel), 'utf-8'), 'brand new guidance\n');
});

test('apply refuses a grown-but-tail-truncated payload', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  const before = '# Guide\nfirst rule\n';
  writeFileSync(path.join(farmslotRoot, rel), before);
  const { run, decisionId } = seedImprovementRun([
    // Grows the file (shrink guard silent) but the tail is cut mid-line.
    { filePath: rel, before, after: '# Guide\nfirst rule\nsecond rule that ends mid-sent' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.refused, [{ filePath: rel, reason: 'truncated-tail' }]);
});

test('markdown-only apply skips the fallback typecheck when no project hook exists', async (t) => {
  setupProject({ validateHook: false });
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  writeFileSync(path.join(farmslotRoot, rel), 'old content\n');
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: 'old content\n', after: 'old content\nmore guidance\n' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 1);
  assert.equal(result.validationPassed, true);
  assert.equal(result.validationOutput, 'skipped — markdown-only apply, no project validate hook');
  assert.equal(
    getRun(run.id)?.decisions.find((d) => d.id === decisionId)?.resolvedAction,
    'applied',
  );
});

test('apply accounts a write failure as write-error refusal', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/blocked.md`;
  const abs = path.join(farmslotRoot, rel);
  writeFileSync(abs, 'old content\n');
  // Read-only file: the anchor read succeeds, the write fails with EACCES.
  chmodSync(abs, 0o444);
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: 'old content\n', after: 'old content\nplus an addition\n' },
  ]);
  t.after(async () => {
    chmodSync(abs, 0o644);
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.refused, [{ filePath: rel, reason: 'write-error' }]);
  assert.equal(
    getRun(run.id)?.decisions.find((d) => d.id === decisionId)?.resolvedAction,
    undefined,
    'card must stay pending',
  );
});

test('apply skips validation when every change was refused', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  writeFileSync(path.join(farmslotRoot, rel), 'drifted content\n');
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: 'original content\n', after: 'anything\n' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  const result = await applyImprovement(run.id, decisionId);

  assert.equal(result.applied.length, 0);
  assert.equal(result.validationOutput, 'skipped — no files applied');
});

test('resolveDecision still resolves dismiss on improvement cards', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  writeFileSync(path.join(farmslotRoot, rel), 'old content\n');
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: 'old content\n', after: 'old content\nmore\n' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  await runResolveDecision({ runId: run.id, decisionId, actionId: 'dismiss' }, () => {});

  assert.equal(
    getRun(run.id)?.decisions.find((d) => d.id === decisionId)?.resolvedAction,
    'dismiss',
  );
  assert.equal(await readFile(path.join(farmslotRoot, rel), 'utf-8'), 'old content\n');
});

test('resolveDecision rejects apply on improvement cards instead of silently resolving', async (t) => {
  setupProject();
  const rel = `projects/${TEST_PROJECT}/fixtures/guide.md`;
  writeFileSync(path.join(farmslotRoot, rel), 'old content\n');
  const { run, decisionId } = seedImprovementRun([
    { filePath: rel, before: 'old content\n', after: 'old content\nmore\n' },
  ]);
  t.after(async () => {
    await cleanupRun(run.id);
    teardownProject();
  });

  await assert.rejects(
    () => runResolveDecision({ runId: run.id, decisionId, actionId: 'apply' }, () => {}),
    /improvement\.apply/,
  );
  assert.equal(
    getRun(run.id)?.decisions.find((d) => d.id === decisionId)?.resolvedAction,
    undefined,
    'card must stay pending after the rejected resolve',
  );
  assert.equal(await readFile(path.join(farmslotRoot, rel), 'utf-8'), 'old content\n');
});
