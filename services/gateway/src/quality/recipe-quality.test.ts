import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isRecipeQualityArtifact, type Run } from '@farmslot/protocol';

import { loadRecipeQualityEvaluation } from './recipe-quality.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example-browser-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
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
      model: 'gpt-5.5',
      runner: 'codex',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: overrides.createdAt ?? '2026-04-16T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-16T00:00:00.000Z',
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

async function writeTaskFile(taskDir: string, body: string): Promise<string> {
  const taskFile = path.join(taskDir, 'TASK.md');
  await mkdir(taskDir, { recursive: true });
  await writeFile(taskFile, body, 'utf-8');
  return taskFile;
}

test('loadRecipeQualityEvaluation preserves a current worker artifact and merges structural checks', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-valid-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Task\nWrite artifacts/recipe-quality.json\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const recipeJson = JSON.stringify({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Proves the example page can be reached.',
    workflow: {
      entry: 'start',
      nodes: {
        start: {
          action: 'navigate',
          intent: 'Open the example page for validation',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  await writeFile(path.join(taskDir, 'artifacts', 'recipe.json'), recipeJson);
  await writeFile(
    path.join(taskDir, 'artifacts', 'recipe-quality.json'),
    JSON.stringify(
      {
        version: 1,
        verdict: 'fail',
        compact: {
          verdict: 'FAIL',
          reasons: ['Live proof did not establish the claimed state.'],
          better_version_guidance: [],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: {
          project: 'example-browser-farm',
          flow_type: 'fix-bug',
          proof_mode: 'mixed',
        },
        meta: {
          producer: 'worker',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      null,
      2,
    ),
  );

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'fix-bug' }),
    recipeJson,
  });

  assert.equal(evaluation.artifact.verdict, 'fail');
  assert.equal(evaluation.artifact.meta.producer, 'worker');
  assert.equal(evaluation.signal.source, 'recipe-quality');
  assert.equal(evaluation.signal.semantic, 'bad');
});

test('loadRecipeQualityEvaluation ignores a worker artifact only when recipe sources are newer', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-stale-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Task\n');
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const qualityPath = path.join(artifactsDir, 'recipe-quality.json');
  const recipePath = path.join(artifactsDir, 'recipe.json');
  await writeFile(
    qualityPath,
    JSON.stringify({
      version: 1,
      verdict: 'fail',
      compact: { verdict: 'FAIL', reasons: ['Old failure.'], better_version_guidance: [] },
      dimensions: {},
      structural_findings: [],
      contextual_findings: [],
      suggested_recipe_delta: [],
      training_fields: { proof_mode: 'mixed' },
      meta: {
        producer: 'worker',
        fallback_used: false,
        legacy_task: false,
        artifact_required: true,
        source_signals: ['recipe-quality.json'],
      },
    }),
  );
  const recipeJson = JSON.stringify({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Current recipe.',
    workflow: {
      entry: 'start',
      nodes: {
        start: { action: 'assert', intent: 'Prove current state.', next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  await writeFile(recipePath, recipeJson);
  await utimes(qualityPath, new Date(1_000), new Date(1_000));
  await utimes(recipePath, new Date(2_000), new Date(2_000));

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'fix-bug' }),
    recipeJson,
  });

  assert.equal(evaluation.artifact.verdict, 'pass');
  assert.equal(evaluation.artifact.meta.producer, 'fallback:recipe-json');
});

test('loadRecipeQualityEvaluation regenerates from recipe structure when the existing artifact is non-conformant (read-only)', async () => {
  // The gateway is the sole producer: a non-conformant file (e.g. an old worker
  // hand-authored compact shape) is never salvaged or fabricated into a fail — it
  // is regenerated from the recipe structure, and the evaluator never writes on read,
  // so the on-disk file is left untouched.
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-readonly-invalid-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Task\nWrite artifacts/recipe-quality.json\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const invalidArtifact = '{"version":1,"verdict":"pass","compact":{"verdict":"PASS"}}';
  await writeFile(path.join(taskDir, 'artifacts', 'recipe-quality.json'), invalidArtifact, 'utf-8');

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'fix-bug' }),
    recipeJson: '{"workflow":{"entry":"start","nodes":{"start":{"action":"assert"}}}}',
  });

  assert.ok(isRecipeQualityArtifact(evaluation.artifact));
  // Regenerated from the recipe structure (not salvaged, not fabricated into a fail).
  assert.notEqual(evaluation.artifact.meta.producer, 'worker');
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts', 'recipe-quality.json'), 'utf-8'),
    invalidArtifact,
  );
});

test('isRecipeQualityArtifact rejects invalid nested contract fields', () => {
  assert.equal(
    isRecipeQualityArtifact({
      version: 1,
      verdict: 'pass',
      compact: { verdict: 'PASS', reasons: ['ok'], better_version_guidance: [] },
      dimensions: {},
      structural_findings: [],
      contextual_findings: [],
      suggested_recipe_delta: [],
      training_fields: { proof_mode: 'bogus' },
      meta: {
        producer: 'worker',
        fallback_used: false,
        legacy_task: false,
        artifact_required: true,
        source_signals: ['recipe-quality.json'],
      },
    }),
    false,
  );

  assert.equal(
    isRecipeQualityArtifact({
      version: 1,
      verdict: 'pass',
      compact: { verdict: 'PASS', reasons: ['ok'], better_version_guidance: [] },
      dimensions: {},
      structural_findings: [],
      contextual_findings: [],
      suggested_recipe_delta: [],
      training_fields: {},
      meta: {
        producer: 'worker',
        legacy_task: false,
        artifact_required: true,
        source_signals: ['recipe-quality.json'],
      },
    }),
    false,
  );

  assert.equal(
    isRecipeQualityArtifact({
      version: 1,
      verdict: 'pass',
      compact: { verdict: 'PASS', reasons: ['ok'], better_version_guidance: [] },
      dimensions: {},
      structural_findings: [],
      contextual_findings: [],
      suggested_recipe_delta: [],
      training_fields: {},
      meta: {
        producer: 'worker',
        fallback_used: false,
        legacy_task: false,
        artifact_required: true,
        fallback_source: 'worker',
        source_signals: ['recipe-quality.json'],
      },
    }),
    false,
  );

  assert.equal(
    isRecipeQualityArtifact({
      version: 1,
      verdict: 'pass',
      compact: { verdict: 'PASS', reasons: ['ok'], better_version_guidance: [] },
      dimensions: {},
      structural_findings: [],
      contextual_findings: [],
      suggested_recipe_delta: [],
      training_fields: { flow_type: 'bogus', proof_mode: 'mixed' },
      meta: {
        producer: 'worker',
        fallback_used: false,
        legacy_task: false,
        artifact_required: true,
        source_signals: ['recipe-quality.json'],
      },
    }),
    false,
  );
});

test('loadRecipeQualityEvaluation warns when legacy recipe coverage exists without canonical artifact', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-legacy-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Legacy task\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts', 'recipe-coverage.md'), '24/25 passed\n', 'utf-8');

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'update-branch' }),
    recipeCoverage: '24/25 passed\n',
  });

  assert.equal(evaluation.artifact.verdict, 'warn');
  assert.equal(evaluation.artifact.meta.artifact_required, false);
  assert.equal(evaluation.signal.source, 'recipe-coverage');
  await assert.rejects(readFile(path.join(taskDir, 'artifacts', 'recipe-quality.json'), 'utf-8'));
});

test('loadRecipeQualityEvaluation does not hard-fail on a missing artifact (gateway is sole producer)', async () => {
  // Even when the task text mentions artifacts/recipe-quality.json, a missing file
  // is no longer a hard "required artifact missing" fail — it is regenerated from
  // the recipe structure, so legacy/non-farmslot tasks that still mention the old
  // artifact are not penalized.
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-required-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(
    taskDir,
    '# Task\nWrite artifacts/recipe-quality.json before report.\n',
  );
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts', 'recipe.json'), '{"entry":"start"}\n', 'utf-8');

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'fix-bug' }),
    recipeJson: '{"entry":"start"}\n',
  });

  assert.ok(isRecipeQualityArtifact(evaluation.artifact));
  assert.equal(evaluation.artifact.meta.artifact_required, false);
  assert.doesNotMatch(
    evaluation.artifact.compact.reasons.join(' '),
    /required.*missing|missing.*required/i,
  );
});

test('loadRecipeQualityEvaluation warns for dev task without recipe artifacts', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-dev-no-recipe-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Dev task without recipe\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts', 'report.md'),
    'Implemented feature without recipe.\n',
    'utf-8',
  );

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'dev' }),
    workerReport: 'Implemented feature without recipe.\n',
  });

  assert.equal(evaluation.artifact.verdict, 'warn');
  assert.equal(evaluation.artifact.meta.artifact_required, false);
  assert.equal(evaluation.signal.source, 'report');
});

test('loadRecipeQualityEvaluation warns for review-pr task without recipe artifacts', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-review-no-recipe-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Review task without recipe\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts', 'report.md'),
    'Review completed without recipe path.\n',
    'utf-8',
  );

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'review-pr' }),
    workerReport: 'Review completed without recipe path.\n',
  });

  assert.equal(evaluation.artifact.verdict, 'warn');
  assert.equal(evaluation.artifact.meta.artifact_required, false);
  assert.equal(evaluation.signal.source, 'report');
});

test('loadRecipeQualityEvaluation derives pass from a valid v1 recipe without a hand-authored artifact', async () => {
  // Gateway is sole producer: with no recipe-quality.json, the verdict comes from
  // the recipe structure — a fully valid recipe earns `pass`/good, not a capped warn.
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-legacy-recipe-json-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Legacy task\n');
  const recipeJson = JSON.stringify({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Validate the current navigation state.',
    workflow: {
      entry: 'start',
      nodes: {
        start: {
          action: 'navigate',
          intent: 'Open the expected application screen.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  });

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'update-branch' }),
    recipeJson,
  });

  assert.equal(evaluation.artifact.verdict, 'pass');
  assert.equal(evaluation.signal.semantic, 'good');
  assert.equal(evaluation.artifact.meta.artifact_required, false);
  assert.equal(evaluation.signal.source, 'recipe-json');
});

test('loadRecipeQualityEvaluation fails invalid recipe json via shared structural checks', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-invalid-json-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Legacy task\n');

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'update-branch' }),
    recipeJson: '{"entry":',
  });

  assert.equal(evaluation.artifact.verdict, 'fail');
  assert.match(evaluation.artifact.compact.reasons.join(' '), /structural recipe issues/i);
  assert.equal(evaluation.artifact.dimensions.graph_integrity.status, 'fail');
});

test('loadRecipeQualityEvaluation does not persist fallback artifact on read', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-no-persist-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Legacy task\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts', 'report.md'),
    'Legacy prose-only report.\n',
    'utf-8',
  );

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'update-branch' }),
    workerReport: 'Legacy prose-only report.\n',
  });

  assert.equal(evaluation.artifact.verdict, 'warn');
  await assert.rejects(readFile(path.join(taskDir, 'artifacts', 'recipe-quality.json'), 'utf-8'));
});

test('loadRecipeQualityEvaluation rejects unreachable nodes in an existing worker artifact', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-unreachable-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Task\nWrite artifacts/recipe-quality.json\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts', 'recipe-quality.json'),
    JSON.stringify(
      {
        version: 1,
        verdict: 'pass',
        compact: {
          verdict: 'PASS',
          reasons: ['Worker provided a valid recipe-quality artifact.'],
          better_version_guidance: [],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: {
          project: 'example-browser-farm',
          flow_type: 'fix-bug',
          proof_mode: 'mixed',
        },
        meta: {
          producer: 'worker',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      null,
      2,
    ),
  );

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'fix-bug' }),
    recipeJson: JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Reject unreachable validation nodes.',
      workflow: {
        entry: 'start',
        nodes: {
          start: {
            action: 'navigate',
            intent: 'Open the expected application screen.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
          orphan: {
            action: 'assert',
            intent: 'Confirm an unreachable application state.',
            next: 'orphan-done',
          },
          'orphan-done': { action: 'end', status: 'pass' },
        },
      },
    }),
  });

  assert.equal(evaluation.artifact.verdict, 'fail');
  assert.equal(evaluation.artifact.dimensions.graph_integrity.status, 'fail');
  assert.match(JSON.stringify(evaluation.artifact.structural_findings), /unreachable/i);
});

test('loadRecipeQualityEvaluation rejects non-v1 direct-format entry/nodes recipes', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-direct-format-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Legacy task\n');

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'update-branch' }),
    recipeJson: JSON.stringify({
      entry: 'start',
      nodes: {
        start: { action: 'navigate', next: 'done' },
        done: { action: 'assert' },
      },
    }),
  });

  assert.equal(evaluation.artifact.verdict, 'fail');
  assert.equal(evaluation.artifact.dimensions.graph_integrity.status, 'fail');
  assert.match(JSON.stringify(evaluation.artifact.structural_findings), /missing_schema/i);
});

test('loadRecipeQualityEvaluation follows switch default branches when computing reachability', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'recipe-quality-switch-default-'));
  const taskDir = path.join(base, 'task');
  const taskFile = await writeTaskFile(taskDir, '# Task\nWrite artifacts/recipe-quality.json\n');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts', 'recipe-quality.json'),
    JSON.stringify(
      {
        version: 1,
        verdict: 'pass',
        compact: {
          verdict: 'PASS',
          reasons: ['Worker provided a valid recipe-quality artifact.'],
          better_version_guidance: [],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: {
          project: 'example-browser-farm',
          flow_type: 'fix-bug',
          proof_mode: 'mixed',
        },
        meta: {
          producer: 'worker',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      null,
      2,
    ),
  );

  const evaluation = await loadRecipeQualityEvaluation({
    run: makeRun({ taskFile, project: 'example-browser-farm', flowType: 'fix-bug' }),
    recipeJson: JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Validate both declared application states.',
      workflow: {
        entry: 'branch',
        nodes: {
          branch: {
            action: 'switch',
            intent: 'Choose the matching application state.',
            cases: { match: 'case-hit' },
            default: 'default-hit',
          },
          'case-hit': {
            action: 'assert',
            intent: 'Confirm the matching application state.',
            next: 'done',
          },
          'default-hit': {
            action: 'assert',
            intent: 'Confirm the default application state.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
  });

  assert.equal(evaluation.artifact.verdict, 'pass');
  assert.equal(evaluation.artifact.dimensions.graph_integrity.status, 'pass');
  assert.doesNotMatch(
    JSON.stringify(evaluation.artifact.structural_findings),
    /unreachable-nodes/i,
  );
});
