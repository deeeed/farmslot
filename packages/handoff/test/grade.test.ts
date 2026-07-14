import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleLearningPackage } from '../src/learning-package/assemble.js';
import type { HandoffContext, LearningPackageInput } from '../src/learning-package/types.js';
import { writeLearningPackage } from '../src/learning-package/write.js';
import type { HumanGrade, IndexRow } from '../src/spec/types.js';
import { validateLearningPackage } from '../src/validate/validate-package.js';

const GRADE: HumanGrade = {
  recipe_semantic: 'good',
  reasoning: 'Clean run; proof targets all passed on first attempt.',
  graded_by: 'eng-1',
  graded_at: '2026-07-13T12:00:00Z',
  proof_target_verdicts: [
    { id: 'pt-1', target: 'gate stays green 50/50', verdict: 'pass', note: 'verified on CI' },
  ],
};

function scenario(grade?: unknown): { ctx: HandoffContext; input: LearningPackageInput } {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'handoff-grade-'));
  const artifactsDir = path.join(workspace, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(workspace, 'TASK.md'), '# Task\n');
  writeFileSync(path.join(artifactsDir, 'report.md'), '# Report\n\nDone.\n');
  writeFileSync(path.join(artifactsDir, 'learnings.md'), '# Learnings\n\nInsight.\n');
  let gradeJson: string | undefined;
  if (grade !== undefined) {
    gradeJson = path.join(artifactsDir, 'grade.json');
    writeFileSync(gradeJson, `${JSON.stringify(grade, null, 2)}\n`);
  }
  return {
    ctx: { stagingRoot: mkdtempSync(path.join(os.tmpdir(), 'handoff-grade-stage-')), workspace },
    input: {
      surface: 'fleet',
      runRecord: {
        packageId: '20260713T120000Z-fleet-dev-proj-123-a1b2c3d4',
        project: 'demo-farm',
        domain: '',
        engineer: 'eng-1',
        run: { startedAt: '2026-07-13T11:00:00Z', flow: 'dev', outcome: 'success' },
        task: { title: 'Do the thing', sourceKind: 'text', ticket: 'PROJ-123' },
      },
      templateProvenance: [],
      taskDoc: { taskMd: path.join(workspace, 'TASK.md') },
      artifacts: { artifactsDir, gradeJson },
    },
  };
}

test('assemble with a grade copies grade.json, registers it in manifest.files, and validates', () => {
  const { ctx, input } = scenario(GRADE);
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const stored = JSON.parse(
    readFileSync(path.join(result.packageDir, 'grade.json'), 'utf8'),
  ) as HumanGrade;
  assert.equal(stored.recipe_semantic, 'good');
  assert.equal(stored.proof_target_verdicts?.[0].verdict, 'pass');
  assert.equal(result.manifest.files['grade.json']?.role, 'optional');

  assert.deepEqual(validateLearningPackage(result.packageDir).errors, []);
});

test('grade fields land in index rows: hasGrade + gradeSemantic (dryRun)', () => {
  const { ctx, input } = scenario(GRADE);
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const write = writeLearningPackage({
    packageDir: result.packageDir,
    destination: mkdtempSync(path.join(os.tmpdir(), 'handoff-grade-dest-')),
    dryRun: true,
  });
  assert.equal(write.status, 'dry-run');
  if (write.status !== 'dry-run') return;
  const row: IndexRow = write.indexRows[0];
  assert.equal(row.hasGrade, true);
  assert.equal(row.gradeSemantic, 'good');
});

test('assemble without a grade is still a valid v1 package: no file, hasGrade false', () => {
  const { ctx, input } = scenario();
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  assert.equal(existsSync(path.join(result.packageDir, 'grade.json')), false);
  assert.deepEqual(validateLearningPackage(result.packageDir).errors, []);

  const write = writeLearningPackage({
    packageDir: result.packageDir,
    destination: mkdtempSync(path.join(os.tmpdir(), 'handoff-grade-dest-')),
    dryRun: true,
  });
  assert.equal(write.status, 'dry-run');
  if (write.status !== 'dry-run') return;
  assert.equal(write.indexRows[0].hasGrade, false);
  assert.equal('gradeSemantic' in write.indexRows[0], false);
});

test('a malformed grade.json refuses assembly (optional content must be valid or absent)', () => {
  const { ctx, input } = scenario({ recipe_semantic: 'excellent', reasoning: 'nope' });
  assert.throws(() => assembleLearningPackage(input, ctx), /fails the grade schema/);
  assert.throws(() => assembleLearningPackage(input, ctx), /Next:/);
});

test('the validator still rejects a malformed grade.json in a hand-tampered package', () => {
  const { ctx, input } = scenario(GRADE);
  const result = assembleLearningPackage(input, ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  writeFileSync(
    path.join(result.packageDir, 'grade.json'),
    `${JSON.stringify({ recipe_semantic: 'excellent', reasoning: 'nope' }, null, 2)}\n`,
  );
  const validation = validateLearningPackage(result.packageDir);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.startsWith('grade.json')));
});

test('the scrub gate applies to grade.json like any package file', () => {
  // Blocking: a planted secret in the grade reasoning blocks the whole assembly.
  const dirty = scenario({
    ...GRADE,
    reasoning:
      'graded after restoring abandon ability able about above absent absorb abstract absurd abuse access accident',
  });
  const blocked = assembleLearningPackage(dirty.input, dirty.ctx);
  assert.equal(blocked.status, 'blocked');
  if (blocked.status !== 'blocked') return;
  assert.ok(blocked.scrubReport.blocked.some((b) => b.file === 'grade.json' && b.kind === 'srp'));

  // Redaction: a non-blocking secret (email) is replaced in the stored copy.
  const redactable = scenario({ ...GRADE, reasoning: 'confirmed with ops@example.com over call' });
  const result = assembleLearningPackage(redactable.input, redactable.ctx);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const stored = readFileSync(path.join(result.packageDir, 'grade.json'), 'utf8');
  assert.equal(stored.includes('ops@example.com'), false);
  assert.match(stored, /\[REDACTED:email:sha256:[a-f0-9]{12}\]/);
});
