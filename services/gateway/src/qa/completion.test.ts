import assert from 'node:assert/strict';
import test from 'node:test';

import {
  digestRecipeDocument,
  type QaResult,
  type RecipeResolutionDocument,
  type Run,
} from '@farmslot/protocol';

import {
  parseQaResult,
  type QaPackage,
  validateQaPackage,
  validateQaScope,
  validateQaSuite,
} from './completion.js';

const startedAt = '2026-09-15T01:00:00.000Z';
const qa = {
  profile: { id: 'changes', title: 'Changed behavior', template_id: 'validation/shared' },
  inputs: { scope: 'pr' },
};
const run = {
  id: 'qa-run',
  flowType: 'qa',
  qa,
  prWork: { headSha: 'a'.repeat(40) },
} as unknown as Run;
const envelope: QaResult = {
  version: 1,
  runId: run.id,
  qa,
  source: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
  suitePath: 'qa-suite',
  scope: {
    path: 'qa-scope.json',
    digest: 'sha256:' + 'a'.repeat(64),
    suiteDigest: 'sha256:' + 'b'.repeat(64),
  },
  packages: { smoke: 'qa-suite/smoke' },
  smoke: { caseId: 'smoke', proofTarget: 'behavior' },
};
function bundle(): QaPackage {
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Controller smoke',
    proofTargets: [{ id: 'behavior', claim: 'Controller returns the requested computed state' }],
    workflow: {
      entry: 'request',
      nodes: {
        request: { action: 'command', cmd: 'controller compute 2 3', next: 'check' },
        check: {
          action: 'assert_output',
          source: 'request',
          contains: '5',
          proves: ['behavior'],
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const trace = [
    { nodeId: 'request', action: 'command', ok: true, output: { stdout: '5', exitCode: 0 } },
    {
      nodeId: 'check',
      action: 'assert_output',
      ok: true,
      proves: ['behavior'],
      output: { source: 'request', stream: 'stdout', assertion: { actual: '5' } },
    },
    { nodeId: 'done', action: 'end', ok: true, status: 'pass' },
  ];
  const summary = {
    status: 'pass',
    total: 3,
    passed: 3,
    failed: 0,
    cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    startedAt,
    endedAt: '2026-09-15T01:00:01.000Z',
  };
  return redigest({
    recipe,
    trace,
    summary,
    manifest: {
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: 'recipe.json', type: 'recipe' },
        { path: 'trace.json', type: 'trace' },
        { path: 'summary.json', type: 'summary' },
      ],
    },
    recipeResolution: {
      schema_version: 1,
      root: { ref: 'smoke', digest: digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    },
    resolvedRecipes: {},
    artifactPaths: [
      'recipe.json',
      'trace.json',
      'summary.json',
      'artifact-manifest.json',
      'recipe-resolution.json',
    ],
  });
}
function redigest(value: QaPackage) {
  for (const [id, node] of Object.entries((value.recipe as any).workflow.nodes) as Array<
    [string, any]
  >)
    if (node.action !== 'end') {
      node.intent = `Verify ${id} behavior.`;
      const entry = (value.trace as any[]).find((step) => step.nodeId === id);
      if (entry) entry.intent = node.intent;
    }
  (value.recipeResolution as RecipeResolutionDocument).root.digest = digestRecipeDocument(
    value.recipe,
  );
  return value;
}

test('QA result is bound to the admitted run, preset, inputs and prepared source', () => {
  assert.deepEqual(parseQaResult(envelope, run, 'a'.repeat(40)), envelope);
  for (const patch of [
    { version: 2 },
    { runId: 'old-run' },
    { qa: { ...qa, inputs: { scope: 'release' } } },
    { source: { ...envelope.source, headSha: 'c'.repeat(40) } },
    { suitePath: '../other-task' },
    { suitePath: '/tmp/old' },
    { packages: undefined },
    { packages: { smoke: '../other-task' } },
    { smoke: { caseId: '', proofTarget: 'behavior' } },
  ])
    assert.throws(
      () => parseQaResult({ ...envelope, ...patch }, run, 'a'.repeat(40)),
      /QA evidence incomplete/,
    );
  assert.throws(
    () =>
      parseQaResult(
        envelope,
        { ...run, prWork: { ...run.prWork!, headSha: 'c'.repeat(40) } },
        'a'.repeat(40),
      ),
    /admitted target/,
  );
});

test('a passing recorded controller action and behavioral assertion can prove smoke', () => {
  const value = bundle();
  assert.equal(validateQaPackage(value, startedAt, 'behavior'), digestRecipeDocument(value.recipe));
});

test('health/launch/prose without an executed assertion cannot satisfy smoke', () => {
  const value = bundle();
  const recipe = value.recipe as any;
  recipe.workflow.nodes.check = { action: 'app.status', proves: ['behavior'], next: 'done' };
  (value.trace as any[])[1] = {
    nodeId: 'check',
    action: 'app.status',
    ok: true,
    output: { healthy: true },
  };
  assert.throws(
    () => validateQaPackage(redigest(value), startedAt, 'behavior'),
    /no executed runtime assertion/,
  );
  const empty = bundle();
  (empty.recipe as any).proofTargets = [];
  delete (empty.recipe as any).workflow.nodes.check.proves;
  assert.throws(
    () => validateQaPackage(redigest(empty), startedAt),
    /no declared behavioral proof/,
  );
});

test('stale, failed, skipped, corrupted and missing-smoke packages fail closed', () => {
  const stale = bundle();
  assert.throws(() => validateQaPackage(stale, '2026-09-15T02:00:00Z', 'behavior'), /predates/);
  const failed = bundle();
  (failed.trace as any[])[1].ok = false;
  assert.throws(() => validateQaPackage(failed, startedAt), /QA evidence incomplete/);
  const skipped = bundle();
  (skipped.trace as any[]).splice(1, 1);
  Object.assign(skipped.summary as object, { total: 2, passed: 2 });
  assert.throws(() => validateQaPackage(skipped, startedAt), /no executed runtime assertion/);
  const changed = bundle();
  (changed.recipe as any).title = 'Changed after execution';
  assert.throws(() => validateQaPackage(changed, startedAt), /digest/);
  assert.throws(
    () => validateQaPackage(bundle(), startedAt, 'not-executed'),
    /smoke proof target is absent/,
  );
  const exitOnly = bundle();
  (exitOnly.recipe as any).workflow.nodes.check.action = 'assert_exit_code';
  (exitOnly.trace as any[])[1].action = 'assert_exit_code';
  assert.throws(
    () => validateQaPackage(redigest(exitOnly), startedAt),
    /no executed runtime assertion/,
  );
});

test('runtime UI smoke needs interaction before the state assertion', () => {
  const value = bundle();
  const recipe = value.recipe as any;
  recipe.workflow.nodes.request = { action: 'app.lifecycle', next: 'check' };
  recipe.workflow.nodes.check = {
    action: 'ui.wait_for',
    selector: '#result',
    proves: ['behavior'],
    next: 'done',
  };
  (value.trace as any[])[0] = {
    nodeId: 'request',
    action: 'app.lifecycle',
    ok: true,
    output: { started: true },
  };
  (value.trace as any[])[1] = {
    nodeId: 'check',
    action: 'ui.wait_for',
    ok: true,
    output: { visible: true },
  };
  assert.throws(
    () => validateQaPackage(redigest(value), startedAt, 'behavior'),
    /no executed runtime assertion/,
  );
  recipe.workflow.nodes.request = { action: 'ui.press', selector: '#calculate', next: 'check' };
  (value.trace as any[])[0] = {
    nodeId: 'request',
    action: 'ui.press',
    ok: true,
    output: { pressed: true },
  };
  assert.doesNotThrow(() => validateQaPackage(redigest(value), startedAt, 'behavior'));
});

test('dynamic suite coverage cannot drop cases, hide nonexecution or substitute summary results', () => {
  const scope = {
    $schema: 'https://farmslot.io/schemas/recipe-suite-scope-v1.schema.json',
    suite_id: 'changes',
    cases: [{ id: 'smoke' }, { id: 'changed-case' }],
  };
  const summaries = {
    'smoke/summary.json': bundle().summary,
    'changed/summary.json': {
      ...(bundle().summary as object),
      endedAt: '2026-09-15T01:00:02.000Z',
    },
  };
  const result = {
    $schema: 'https://farmslot.io/schemas/recipe-suite-result-v1.schema.json',
    suite_id: 'changes',
    scope_digest: digestRecipeDocument(scope),
    totals: { declared: 2, executed: 2, not_executed: 0 },
    resolutions: [
      {
        id: 'smoke',
        kind: 'verdict',
        status: 'pass',
        summary_path: 'smoke/summary.json',
        summary_digest: digestRecipeDocument(summaries['smoke/summary.json']),
      },
      {
        id: 'changed-case',
        kind: 'verdict',
        status: 'pass',
        summary_path: 'changed/summary.json',
        summary_digest: digestRecipeDocument(summaries['changed/summary.json']),
      },
    ],
  };
  assert.doesNotThrow(() => validateQaSuite(scope, result, summaries, envelope.smoke));
  assert.throws(
    () =>
      validateQaSuite(
        scope,
        { ...result, resolutions: result.resolutions.slice(0, 1) },
        summaries,
        envelope.smoke,
      ),
    /QA evidence incomplete/,
  );
  assert.throws(
    () =>
      validateQaSuite(
        scope,
        { ...result, scope_digest: 'sha256:' + 'f'.repeat(64) },
        summaries,
        envelope.smoke,
      ),
    /scope_digest/,
  );
  const omitted = {
    ...result,
    totals: { declared: 2, executed: 1, not_executed: 1 },
    resolutions: [
      result.resolutions[0],
      {
        id: 'changed-case',
        kind: 'not_executed',
        reason_class: 'prerequisite_missing',
        detail: 'Device offline',
      },
    ],
  };
  assert.throws(
    () =>
      validateQaSuite(
        scope,
        omitted,
        { 'smoke/summary.json': summaries['smoke/summary.json'] },
        envelope.smoke,
      ),
    /unexecuted coverage/,
  );
  assert.throws(
    () =>
      validateQaSuite(
        scope,
        result,
        {
          'smoke/summary.json': { ...(bundle().summary as object), status: 'unknown' },
          'changed/summary.json': bundle().summary,
        },
        envelope.smoke,
      ),
    /QA evidence incomplete/,
  );
});

test('QA keeps the frozen target while the skill selects its scope baseline', () => {
  assert.doesNotThrow(() =>
    parseQaResult(envelope, { ...run, qaSource: envelope.source }, envelope.source.headSha),
  );
  assert.doesNotThrow(() =>
    parseQaResult(
      envelope,
      { ...run, qaSource: { ...envelope.source, baseSha: 'c'.repeat(40) } },
      envelope.source.headSha,
    ),
  );
  assert.throws(
    () =>
      parseQaResult(
        envelope,
        { ...run, qaSource: { ...envelope.source, headSha: 'c'.repeat(40) } },
        envelope.source.headSha,
      ),
    /frozen QA target/,
  );
});

test('a composed smoke case validates its exact retained dependency and nested runtime assertion', () => {
  const value = bundle();
  const child = structuredClone(value.recipe);
  const digest = digestRecipeDocument(child);
  const artifact = `resolved-recipes/${digest.slice(7)}.recipe.json`;
  value.recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Selected library smoke',
    proofTargets: [{ id: 'behavior', claim: 'Controller returns the requested computed state' }],
    workflow: {
      entry: 'smoke',
      nodes: {
        smoke: {
          action: 'call',
          ref: 'team/smoke',
          intent: 'Run the selected controller smoke.',
          proves: ['behavior'],
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  value.trace = [
    { nodeId: 'smoke', action: 'call', intent: 'Run the selected controller smoke.', ok: true },
    ...(value.trace as any[]).map((entry) => ({ ...entry, nodeId: `smoke/${entry.nodeId}` })),
    { nodeId: 'done', action: 'end', ok: true, status: 'pass' },
  ];
  Object.assign(value.summary as object, { total: 5, passed: 5 });
  value.recipeResolution = {
    schema_version: 1,
    root: { ref: 'root', digest: digestRecipeDocument(value.recipe) },
    dependencies: [
      { ref: 'team/smoke', source: 'farm-library', file: 'smoke.recipe.json', digest, artifact },
    ],
    edges: [{ from: 'root', to: 'team/smoke' }],
  };
  value.resolvedRecipes = { [digest]: child };
  value.artifactPaths.push(artifact);
  assert.doesNotThrow(() => validateQaPackage(value, startedAt, 'behavior'));
  delete value.resolvedRecipes[digest];
  assert.throws(() => validateQaPackage(value, startedAt, 'behavior'), /Missing resolved recipe/);
});

test('QA binds retained change scope, reported revisions and declared suite', () => {
  const source = { ...envelope.source, kind: 'range', files: ['changed.ts'] };
  const suite = { suite_id: 'qa', cases: [{ id: 'smoke' }] };
  const result = {
    ...envelope,
    scope: {
      path: 'qa-scope.json',
      digest: digestRecipeDocument(source),
      suiteDigest: digestRecipeDocument(suite),
    },
  };
  assert.doesNotThrow(() => validateQaScope(result, source, suite));
  assert.throws(
    () => validateQaScope(result, { ...source, baseSha: 'c'.repeat(40) }, suite),
    /reported source/,
  );
  assert.throws(() => validateQaScope(result, { ...source, files: [] }, suite), /scope digest/);
  assert.throws(() => validateQaScope(result, source, { ...suite, cases: [] }), /suite differs/);
});
