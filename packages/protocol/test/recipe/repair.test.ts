import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPipelineRepairVisualJudgments,
  nativeResultJsonSchema,
  nativeStructuredResult,
  PIPELINE_REPAIR_VISUAL_JUDGMENTS_SCHEMA,
  PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA,
  PIPELINE_VISUAL_JUDGMENTS_SCHEMA,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type PipelineRepairVisualJudgments,
  type RecipeClaimEvidence,
  recipeRepairId,
  type RecipeRepairScope,
  recipeRepairScopeDigest,
  selectRepairClaimSources,
  validateRecipeParamsSchema,
  validateRecipeRepairScope,
  validateRecipeRepairSelection,
} from '../../src/index.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
// The ready gate's package identity is a bare sha256 hex digest.
const packageHash = 'b'.repeat(64);

function scopeFixture(overrides: Partial<RecipeRepairScope> = {}): RecipeRepairScope {
  const base: Omit<RecipeRepairScope, 'repairId'> = {
    schemaVersion: 1,
    runId: 'run-1',
    generation: 2,
    decisionId: 'decision-1',
    packageHash,
    packageHeadSha: 'c'.repeat(40),
    reviewBaseSha: 'd'.repeat(40),
    reviewId: 'review-1',
    workerContextId: 'run-1:dev',
    repairRecipe: 'recipes/visual-repair.json',
    claims: [
      { id: 'AC-1', claim: 'The header shows the price.', proofMode: 'visual' },
      { id: 'AC-2', claim: 'The chart renders.', proofMode: 'visual' },
      { id: 'AC-3', claim: 'The order is stored.', proofMode: 'state' },
    ],
    sources: [
      {
        recipeRunId: 'original',
        closureIdentity: digest('e'),
        artifactRoot: 'artifacts/recipe-runs/original',
        headSha: 'c'.repeat(40),
      },
    ],
    retained: [
      { claimId: 'AC-1', recipeRunId: 'original' },
      { claimId: 'AC-3', recipeRunId: 'original' },
    ],
    rejected: [
      {
        claimId: 'AC-2',
        proofMode: 'visual',
        receiptId: 'receipt-2',
        reason: 'The chart is blank.',
        recipeRunId: 'original',
        closureIdentity: digest('e'),
        reviewedFiles: [{ path: 'stills/chart.png', digest: digest('f') }],
        moments: [],
      },
    ],
  };
  return {
    ...base,
    repairId: recipeRepairId({ runId: 'run-1', packageHash, receiptIds: ['receipt-2'] }),
    ...overrides,
  };
}

function fresh(
  id: string,
  verdict: RecipeClaimEvidence['verdict'],
  proofMode: RecipeClaimEvidence['proofMode'] = 'visual',
): RecipeClaimEvidence {
  return {
    id,
    text: id,
    kind: 'acceptance',
    proofMode,
    verdict,
    recipeNodes: [],
    assertionIndices: [],
    evidence: [],
    moments: [],
  };
}

test('repair identity binds the package and sorted rejection receipts', () => {
  const left = recipeRepairId({ runId: 'r', packageHash, receiptIds: ['b', 'a'] });
  assert.equal(left, recipeRepairId({ runId: 'r', packageHash, receiptIds: ['a', 'b'] }));
  assert.notEqual(left, recipeRepairId({ runId: 'r', packageHash, receiptIds: ['a'] }));
  assert.notEqual(
    left,
    recipeRepairId({ runId: 'r', packageHash: '9'.repeat(64), receiptIds: ['a'] }),
  );
  assert.match(left, /^repair-[a-f0-9]{24}$/u);
});

test('a complete repair scope validates and every malformed authority is refused', () => {
  assert.equal(validateRecipeRepairScope(scopeFixture()).status, 'valid');
  const invalid: Array<[string, unknown]> = [
    ['forged identity', scopeFixture({ repairId: 'repair-forged' })],
    ['no issue', scopeFixture({ rejected: [] })],
    [
      'nested criteria',
      scopeFixture({
        claims: [
          { id: 'AC-1', claim: 'Parent' },
          { id: 'AC-2', claim: 'Child', parentId: 'AC-1' },
          { id: 'AC-3', claim: 'Other' },
        ],
      }),
    ],
    [
      'uncovered criterion',
      scopeFixture({ retained: [{ claimId: 'AC-1', recipeRunId: 'original' }] }),
    ],
    [
      'retained rejected',
      scopeFixture({
        retained: [
          { claimId: 'AC-1', recipeRunId: 'original' },
          { claimId: 'AC-2', recipeRunId: 'original' },
          { claimId: 'AC-3', recipeRunId: 'original' },
        ],
      }),
    ],
    [
      'foreign source',
      scopeFixture({
        retained: [
          { claimId: 'AC-1', recipeRunId: 'other' },
          { claimId: 'AC-3', recipeRunId: 'original' },
        ],
      }),
    ],
    ['escaping recipe', scopeFixture({ repairRecipe: '../recipe.json' })],
    ['main artifacts recipe', scopeFixture({ repairRecipe: 'artifacts/recipe.json' })],
    ['short head', scopeFixture({ packageHeadSha: 'abc' })],
    [
      'unknown proof mode',
      scopeFixture({
        rejected: [{ ...scopeFixture().rejected[0]!, proofMode: 'pixel' as 'visual' }],
      }),
    ],
  ];
  for (const [label, value] of invalid)
    assert.equal(validateRecipeRepairScope(value).status, 'invalid', label);
});

test('rejected criteria always select fresh proof and missing siblings keep retained proof', () => {
  const scope = scopeFixture();
  assert.deepEqual(
    selectRepairClaimSources(scope, [
      fresh('AC-1', 'missing'),
      fresh('AC-2', 'missing'),
      fresh('AC-3', 'proven', 'state'),
    ]),
    [
      {
        claimId: 'AC-1',
        source: 'retained',
        recipeRunId: 'original',
        closureIdentity: digest('e'),
      },
      { claimId: 'AC-2', source: 'fresh' },
      { claimId: 'AC-3', source: 'fresh' },
    ],
  );
});

test('a fresh failed or weak sibling is selected and cannot be hidden by older proof', () => {
  const rows = selectRepairClaimSources(scopeFixture(), [
    fresh('AC-1', 'failed'),
    fresh('AC-2', 'awaiting-review'),
    fresh('AC-3', 'weak', 'state'),
  ]);
  assert.deepEqual(
    rows.map((row) => row.source),
    ['fresh', 'fresh', 'fresh'],
  );
});

test('selection validation requires the exact engine rule, scope digest and frozen proof mode', () => {
  const scope = scopeFixture();
  const criteria = [
    fresh('AC-1', 'missing'),
    fresh('AC-2', 'awaiting-review'),
    fresh('AC-3', 'missing', 'state'),
  ];
  const selection = {
    schemaVersion: 1,
    repairId: scope.repairId,
    scopeDigest: recipeRepairScopeDigest(scope),
    recipeRunId: 'fresh-run',
    claims: selectRepairClaimSources(scope, criteria),
  };
  assert.equal(
    validateRecipeRepairSelection(selection, scope, { recipeRunId: 'fresh-run', criteria }).status,
    'valid',
  );
  const relabelled = {
    ...selection,
    claims: selection.claims.map((row) =>
      row.claimId === 'AC-2'
        ? {
            claimId: 'AC-2',
            source: 'retained',
            recipeRunId: 'original',
            closureIdentity: digest('e'),
          }
        : row,
    ),
  };
  for (const [label, value, freshInput] of [
    ['relabelled rejected', relabelled, { recipeRunId: 'fresh-run', criteria }],
    [
      'foreign scope',
      { ...selection, scopeDigest: digest('0') },
      { recipeRunId: 'fresh-run', criteria },
    ],
    ['foreign execution', selection, { recipeRunId: 'other-run', criteria }],
    [
      'state proof for visual issue',
      selection,
      {
        recipeRunId: 'fresh-run',
        criteria: [criteria[0]!, fresh('AC-2', 'proven', 'state'), criteria[2]!],
      },
    ],
    [
      'omitted registration',
      selection,
      { recipeRunId: 'fresh-run', criteria: criteria.slice(0, 2) },
    ],
  ] as const)
    assert.equal(validateRecipeRepairSelection(value, scope, freshInput).status, 'invalid', label);
});

test('v2 repair results carry per-source judgments and typed retained applicability', () => {
  assert.equal(validateRecipeParamsSchema(PIPELINE_REPAIR_VISUAL_JUDGMENTS_SCHEMA).status, 'valid');
  assert.equal(
    nativeResultJsonSchema(PIPELINE_VISUAL_RESULT_SCHEMA),
    PIPELINE_VISUAL_JUDGMENTS_SCHEMA,
  );
  assert.equal(
    nativeResultJsonSchema(PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA),
    PIPELINE_REPAIR_VISUAL_JUDGMENTS_SCHEMA,
  );
  const value: PipelineRepairVisualJudgments = {
    schemaVersion: 2,
    headSha: 'a'.repeat(40),
    scopeDigest: digest('1'),
    sources: [
      {
        schemaVersion: 1,
        recipeRunId: 'fresh-run',
        closureIdentity: digest('2'),
        judgments: [
          {
            claimId: 'AC-2',
            verdict: 'confirmed',
            reason: 'The chart now renders candles.',
            reviewedFiles: [{ path: 'stills/chart.png', digest: digest('3') }],
            moments: [],
          },
        ],
      },
    ],
    retained: [
      {
        claimId: 'AC-1',
        recipeRunId: 'original',
        closureIdentity: digest('e'),
        unaffected: true,
        reason: 'The repair diff only touches the chart component.',
      },
    ],
  };
  assert.ok(isPipelineRepairVisualJudgments(value));
  assert.deepEqual(
    nativeStructuredResult(PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA, value)?.value,
    value,
  );
  // A v1 contract never accepts a v2 value, and vice versa.
  assert.equal(nativeStructuredResult(PIPELINE_VISUAL_RESULT_SCHEMA, value), undefined);
  assert.equal(
    nativeStructuredResult(PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA, value.sources[0]),
    undefined,
  );
  for (const invalid of [
    { ...value, retained: [value.retained[0], value.retained[0]] },
    { ...value, retained: [{ ...value.retained[0], unaffected: 'yes' }] },
    { ...value, retained: [{ ...value.retained[0], reason: ' ' }] },
    { ...value, sources: [value.sources[0], value.sources[0]] },
    { ...value, headSha: 'HEAD' },
  ])
    assert.equal(isPipelineRepairVisualJudgments(invalid), false);
});
