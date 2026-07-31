import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  digestRecipeDocument,
  digestRecipeSuiteScope,
  RECIPE_SUITE_RESULT_SCHEMA_URL,
  RECIPE_SUITE_SCOPE_SCHEMA_URL,
  validateRecipeSuitePackage,
  validateRecipeSuiteResultDocument,
  validateRecipeSuiteScopeDocument,
} from '../../src/index.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

function summary(status: 'pass' | 'fail' | 'unknown') {
  const failed = status === 'fail' ? 1 : 0;
  return {
    status,
    total: 1,
    passed: failed ? 0 : 1,
    failed,
    cause_counts: {
      subject: failed,
      harness: 0,
      environment: 0,
      unknown: 0,
    },
  };
}

function validPackage() {
  const scope = {
    $schema: RECIPE_SUITE_SCOPE_SCHEMA_URL,
    suite_id: 'suite.contract',
    cases: [{ id: 'passes' }, { id: 'fails' }, { id: 'manual' }],
  } as const;
  const summaries = {
    'summaries/pass.json': summary('pass'),
    'summaries/fail.json': summary('fail'),
  };
  const result = {
    $schema: RECIPE_SUITE_RESULT_SCHEMA_URL,
    suite_id: scope.suite_id,
    scope_digest: digestRecipeSuiteScope(scope),
    totals: { declared: 3, executed: 2, not_executed: 1 },
    resolutions: [
      {
        id: 'passes',
        kind: 'verdict',
        status: 'pass',
        summary_path: 'summaries/pass.json',
        summary_digest: digestRecipeDocument(summaries['summaries/pass.json']),
      },
      {
        id: 'fails',
        kind: 'verdict',
        status: 'fail',
        summary_path: 'summaries/fail.json',
        summary_digest: digestRecipeDocument(summaries['summaries/fail.json']),
      },
      {
        id: 'manual',
        kind: 'not_executed',
        reason_class: 'needs_manual',
        detail: 'Requires a hardware confirmation.',
      },
    ],
  } as const;
  return { scope, result, summaries };
}

test('publishes byte-identical, described suite schemas', async () => {
  for (const name of ['recipe-suite-scope-v1.schema.json', 'recipe-suite-result-v1.schema.json']) {
    const packaged = await readFile(path.join(repoRoot, 'packages/protocol/schemas', name), 'utf8');
    const docs = await readFile(path.join(repoRoot, 'apps/docs/static/schemas', name), 'utf8');
    assert.equal(docs, packaged);

    const schema = JSON.parse(packaged) as Record<string, unknown>;
    const missing: string[] = [];
    const visit = (value: unknown, location: string): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      if (record.properties && typeof record.properties === 'object') {
        for (const [key, property] of Object.entries(
          record.properties as Record<string, Record<string, unknown>>,
        )) {
          if (!property.$ref && typeof property.description !== 'string')
            missing.push(`${location}.${key}`);
          visit(property, `${location}.${key}`);
        }
      }
      if (record.$defs && typeof record.$defs === 'object') {
        for (const [key, definition] of Object.entries(record.$defs as Record<string, unknown>)) {
          visit(definition, `$defs.${key}`);
        }
      }
      for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
        const variants = record[keyword];
        if (Array.isArray(variants))
          variants.forEach((variant, index) => visit(variant, `${location}.${keyword}[${index}]`));
      }
      visit(record.items, `${location}[]`);
    };
    visit(schema, '$');
    assert.deepEqual(missing, [], name);
    assert.doesNotThrow(() => new Ajv2020({ strict: true }).compile(schema));
  }
});

test('published suite schemas enforce the v1 wire shapes', async () => {
  const input = validPackage();
  const ajv = new Ajv2020({ strict: true });
  const validateScope = ajv.compile(
    JSON.parse(
      await readFile(
        path.join(repoRoot, 'packages/protocol/schemas/recipe-suite-scope-v1.schema.json'),
        'utf8',
      ),
    ),
  );
  const validateResult = ajv.compile(
    JSON.parse(
      await readFile(
        path.join(repoRoot, 'packages/protocol/schemas/recipe-suite-result-v1.schema.json'),
        'utf8',
      ),
    ),
  );
  assert.equal(validateScope(input.scope), true, JSON.stringify(validateScope.errors));
  assert.equal(validateResult(input.result), true, JSON.stringify(validateResult.errors));
  assert.equal(validateScope({ ...input.scope, cases: [] }), false);
  assert.equal(validateScope({ ...input.scope, cases: [{ id: 'same' }, { id: 'same' }] }), false);
  assert.equal(validateResult({ ...input.result, resolutions: [] }), false);
  assert.equal(
    validateResult({ ...input.result, totals: { ...input.result.totals, declared: 0 } }),
    false,
  );
  assert.equal(
    validateResult({
      ...input.result,
      resolutions: input.result.resolutions.map((resolution) =>
        resolution.kind === 'verdict'
          ? { ...resolution, summary_path: '../outside.json' }
          : resolution,
      ),
    }),
    false,
  );
  assert.equal(
    validateResult({
      ...input.result,
      resolutions: [
        {
          id: 'manual',
          kind: 'not_executed',
          reason_class: 'ordering_dependent',
          detail: 'Blocked without naming a blocker.',
        },
      ],
    }),
    false,
  );
});

test('validates frozen suite scope and result documents', () => {
  const input = validPackage();
  assert.equal(validateRecipeSuiteScopeDocument(input.scope).status, 'valid');
  assert.equal(validateRecipeSuiteResultDocument(input.result).status, 'valid');
  assert.equal(
    validateRecipeSuiteResultDocument({
      ...input.result,
      resolutions: [],
    }).status,
    'invalid',
  );

  for (const invalidScope of [
    { ...input.scope, cases: [] },
    { ...input.scope, cases: [{ id: '' }] },
    { ...input.scope, cases: [{ id: 'same' }, { id: 'same' }] },
  ]) {
    assert.equal(validateRecipeSuiteScopeDocument(invalidScope).status, 'invalid');
  }
});

test('fails closed when suite coverage or retained summaries do not reconcile', () => {
  const input = validPackage();
  assert.equal(validateRecipeSuitePackage(input).status, 'valid');

  const mutations = [
    { ...input, result: { ...input.result, suite_id: 'other' } },
    { ...input, result: { ...input.result, scope_digest: `sha256:${'0'.repeat(64)}` } },
    { ...input, result: { ...input.result, resolutions: input.result.resolutions.slice(1) } },
    {
      ...input,
      result: {
        ...input.result,
        resolutions: [...input.result.resolutions, { ...input.result.resolutions[0], id: 'extra' }],
      },
    },
    {
      ...input,
      result: {
        ...input.result,
        resolutions: [...input.result.resolutions, input.result.resolutions[0]],
      },
    },
    ...(['declared', 'executed', 'not_executed'] as const).map((key) => ({
      ...input,
      result: {
        ...input.result,
        totals: { ...input.result.totals, [key]: input.result.totals[key] + 1 },
      },
    })),
    { ...input, summaries: { 'summaries/fail.json': input.summaries['summaries/fail.json'] } },
    { ...input, summaries: { ...input.summaries, 'summaries/unreferenced.json': summary('pass') } },
    {
      ...input,
      summaries: { ...input.summaries, 'summaries/pass.json': summary('unknown') },
    },
    {
      ...input,
      result: {
        ...input.result,
        resolutions: input.result.resolutions.map((resolution) =>
          resolution.id === 'passes'
            ? { ...resolution, summary_path: '../outside.json' }
            : resolution,
        ),
      },
    },
  ];
  for (const mutation of mutations) {
    assert.equal(validateRecipeSuitePackage(mutation).status, 'invalid');
  }
});

test('rejects distinct cases backed by the same retained run', () => {
  const input = validPackage();
  const passVerdict = input.result.resolutions[0];
  const result = {
    ...input.result,
    resolutions: input.result.resolutions.map((resolution) =>
      resolution.id === 'fails' ? { ...passVerdict, id: 'fails' } : resolution,
    ),
  };
  const validation = validateRecipeSuitePackage({ ...input, result });
  assert.equal(validation.status, 'invalid');
  assert.equal(
    validation.findings.some((finding) => finding.code === 'recipe_suite.duplicate_summary_path'),
    true,
  );
  assert.equal(
    validation.findings.some((finding) => finding.code === 'recipe_suite.duplicate_summary_digest'),
    true,
  );
});

test('enforces explicit and truthful non-execution reasons', () => {
  const input = validPackage();
  const replaceManual = (resolution: Record<string, unknown>) => ({
    ...input,
    result: {
      ...input.result,
      resolutions: input.result.resolutions.map((entry) =>
        entry.id === 'manual' ? resolution : entry,
      ),
    },
  });

  for (const invalid of [
    replaceManual({ id: 'manual', kind: 'not_executed', detail: 'Missing reason.' }),
    replaceManual({
      id: 'manual',
      kind: 'not_executed',
      reason_class: 'other',
      detail: 'Invalid reason.',
    }),
    replaceManual({
      id: 'manual',
      kind: 'not_executed',
      reason_class: 'needs_manual',
      detail: '',
    }),
    replaceManual({
      id: 'manual',
      kind: 'not_executed',
      reason_class: 'ordering_dependent',
      detail: 'Blocked.',
      blocked_by: [],
    }),
    replaceManual({
      id: 'manual',
      kind: 'not_executed',
      reason_class: 'ordering_dependent',
      detail: 'Blocked.',
      blocked_by: ['undeclared'],
    }),
    replaceManual({
      id: 'manual',
      kind: 'not_executed',
      reason_class: 'ordering_dependent',
      detail: 'Blocked.',
      blocked_by: ['passes'],
    }),
    replaceManual({
      id: 'manual',
      kind: 'not_executed',
      reason_class: 'ordering_dependent',
      detail: 'Blocked by itself.',
      blocked_by: ['manual'],
    }),
    replaceManual({
      id: 'manual',
      kind: 'not_executed',
      reason_class: 'oversight',
      detail: 'The case was accidentally skipped.',
    }),
  ]) {
    assert.equal(validateRecipeSuitePackage(invalid).status, 'invalid');
  }

  const cycle = {
    ...input,
    scope: {
      ...input.scope,
      cases: [...input.scope.cases, { id: 'other' }],
    },
  };
  const cyclicResult = {
    ...cycle.result,
    scope_digest: digestRecipeSuiteScope(cycle.scope),
    totals: { declared: 4, executed: 2, not_executed: 2 },
    resolutions: [
      ...cycle.result.resolutions.filter((resolution) => resolution.id !== 'manual'),
      {
        id: 'manual',
        kind: 'not_executed' as const,
        reason_class: 'ordering_dependent' as const,
        detail: 'Blocked by other.',
        blocked_by: ['other'],
      },
      {
        id: 'other',
        kind: 'not_executed' as const,
        reason_class: 'ordering_dependent' as const,
        detail: 'Blocked by manual.',
        blocked_by: ['manual'],
      },
    ],
  };
  assert.equal(validateRecipeSuitePackage({ ...cycle, result: cyclicResult }).status, 'invalid');
});
