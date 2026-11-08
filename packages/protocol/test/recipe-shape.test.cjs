const assert = require('node:assert/strict');
const test = require('node:test');
const {
  scoreRecipeShape,
  inspectRecipeShape,
  isRecipeShapeFeedback,
  RECIPE_SHAPE_POLICY,
  recipeShapeLibraryRef,
} = require('../recipe-shape.mjs');

const catalog = { available: true, blocks: [], sources: [] };
function recipe() {
  return {
    proofTargets: [{ id: 'AC-1', claim: 'State is observed', proofMode: 'state' }],
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'gateway.read', market: 'ETH', account: 'proof-account', next: 'check' },
        check: {
          action: 'assert_output',
          source: 'read',
          contains: 'ready',
          proves: ['AC-1'],
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}
const criteria = [{ id: 'AC-1' }];
test('canonical policy and low-parameter advice identify exact counted fields', () => {
  assert.deepEqual(RECIPE_SHAPE_POLICY.positive, { short: 0.6, composed: 0.8, parameterized: 0.7 });
  const result = scoreRecipeShape({ recipe: recipe(), catalog, criteria });
  assert.equal(result.nodes, 2);
  assert.equal(result.parameterized, 0);
  assert.equal(result.status, 'warn');
  assert.deepEqual(
    result.hints.filter((h) => h.kind === 'parameterize').map((h) => h.field),
    ['read.market', 'read.account'],
  );
  assert.equal(result.acCoverage.complete, true);
  assert.equal(result.eligibleForImitation, false);
  assert.equal(isRecipeShapeFeedback(result), true);
});
test('typed parameter references improve the same graph without changing AC bindings', () => {
  const doc = recipe();
  doc.paramsSchema = {
    type: 'object',
    properties: {
      market: { type: 'string', default: 'ETH' },
      account: { type: 'string', default: 'proof-account' },
    },
  };
  doc.workflow.nodes.read.market = '{{params.market}}';
  doc.workflow.nodes.read.account = '{{params.account}}';
  const result = scoreRecipeShape({ recipe: doc, catalog, criteria });
  assert.equal(result.parameterized, 1);
  assert.equal(result.goodShape, true);
  assert.equal(result.eligibleForImitation, true);
  assert.equal(result.status, 'ok');
});
test('a diagnostic or a recipe-selected AC subset cannot qualify for task imitation', () => {
  assert.equal(
    scoreRecipeShape({ recipe: recipe(), catalog, criteria: [] }).eligibleForImitation,
    false,
  );
  const result = scoreRecipeShape({
    recipe: recipe(),
    catalog,
    criteria: [...criteria, { id: 'AC-2' }],
  });
  assert.deepEqual(result.acCoverage.missing, ['AC-2']);
  assert.equal(result.eligibleForImitation, false);
});
test('review-only and unreachable proving nodes never get local coverage', () => {
  const doc = recipe();
  doc.proofTargets[0].proofMode = 'review';
  assert.deepEqual(scoreRecipeShape({ recipe: doc, catalog, criteria }).acCoverage.reviewOnly, [
    'AC-1',
  ]);
  assert.deepEqual(scoreRecipeShape({ recipe: doc, catalog, criteria }).acCoverage.covered, []);
  const unreachable = recipe();
  unreachable.workflow.nodes.read.next = 'done';
  assert.deepEqual(
    scoreRecipeShape({ recipe: unreachable, catalog, criteria }).acCoverage.missing,
    ['AC-1'],
  );
});
test('duplicated library steps produce a named replacement hint', () => {
  const result = scoreRecipeShape({
    recipe: recipe(),
    criteria,
    catalog: {
      ...catalog,
      blocks: [{ id: 'flow:state', ref: 'state.observe', sig: ['gateway.read', 'assert_output'] }],
    },
  });
  assert.equal(result.composed, 0);
  assert.equal(result.hints.find((h) => h.kind === 'compose').ref, 'state.observe');
});
test('missing context and oversized catalogs are never successful coverage', () => {
  const result = scoreRecipeShape({ recipe: recipe() });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.composed, null);
  assert.equal(result.eligibleForImitation, false);
  assert.throws(
    () =>
      scoreRecipeShape({
        recipe: recipe(),
        catalog: { ...catalog, blocks: Array.from({ length: 2049 }, () => ({ id: 'flow' })) },
      }),
    /2048/,
  );
});
test('end nodes are excluded, call nodes included, and legacy short halves round evenly', () => {
  const doc = recipe();
  doc.workflow.nodes.read.action = 'call';
  assert.equal(inspectRecipeShape(doc).order.length, 2);
  const nodes = {};
  for (let i = 0; i < 14; i++)
    nodes[`n${i}`] = { action: 'read', ...(i < 13 ? { next: `n${i + 1}` } : {}) };
  assert.equal(
    scoreRecipeShape({ recipe: { workflow: { entry: 'n0', nodes } }, catalog }).short,
    0.812,
  );
  const result = scoreRecipeShape({ recipe: recipe(), catalog, criteria });
  assert.equal(isRecipeShapeFeedback({ ...result, hints: [null] }), false);
});

test('archived CSS glob selectors retain fnmatch ranges without throwing', () => {
  const doc = recipe();
  doc.workflow.nodes.read = { action: 'ui.press', selector: 'item-a-next', next: 'check' };
  assert.equal(
    scoreRecipeShape({
      recipe: doc,
      criteria,
      catalog: { ...catalog, blocks: [{ id: 'range', sig: ['ui.press|selector=item-[a-z]-*'] }] },
    }).composed,
    0.5,
  );
  assert.equal(
    scoreRecipeShape({
      recipe: doc,
      criteria,
      catalog: { ...catalog, blocks: [{ id: 'empty-range', sig: ['ui.press|selector=[z-a]*'] }] },
    }).composed,
    1,
  );
  const css =
    'ui.press|selector=[aria-label="Switch market, current *"], [aria-label^="Switch market, current *-"]';
  assert.equal(
    scoreRecipeShape({
      recipe: doc,
      criteria,
      catalog: { ...catalog, blocks: [{ id: 'archived-css', sig: [css] }] },
    }).composed,
    1,
  );
});

test('composed claim bindings cover parent claims without counting IDs as parameters', () => {
  const doc = {
    workflow: {
      entry: 'proof',
      nodes: { proof: { action: 'call', ref: 'proof.observe', claimBindings: { check: 'AC-1' } } },
    },
  };
  const result = scoreRecipeShape({ recipe: doc, catalog, criteria: [{ id: 'AC-1' }] });
  assert.equal(result.parameterized, 1);
  assert.deepEqual(result.acCoverage.covered, ['AC-1']);
  assert.equal(result.acCoverage.complete, true);
});

test('calling a shared block does not hide a second inline copy', () => {
  const doc = recipe();
  doc.workflow.nodes.call = { action: 'call', ref: 'state.observe', next: 'read' };
  doc.workflow.entry = 'call';
  const result = scoreRecipeShape({
    recipe: doc,
    criteria,
    catalog: {
      ...catalog,
      blocks: [{ id: 'flow:state', ref: 'state.observe', sig: ['gateway.read', 'assert_output'] }],
    },
  });
  assert.equal(result.composed, 0.333);
  assert.deepEqual(result.inlineDuplicates[0].nodes, ['read', 'check']);
});

test('inherited obligations remain separate while fresh obligations require proof', () => {
  const doc = recipe();
  doc.workflow.nodes.check.proves = ['AC-1', 'AC-2'];
  const result = scoreRecipeShape({
    recipe: doc,
    catalog,
    criteria: [{ id: 'AC-2' }],
    nonLocalCriteria: ['AC-1'],
  });
  assert.deepEqual(result.acCoverage.unexpected, []);
  assert.deepEqual(result.acCoverage.covered, ['AC-2']);
  assert.deepEqual(result.acCoverage.nonLocal, ['AC-1']);
  assert.equal(result.acCoverage.complete, true);
});

test('catalog references follow resolver scopes, platform variants and local library roots', () => {
  for (const file of [
    'recipes/ac/ac1.recipe.json',
    'shared/ac/ac1.recipe.json',
    'mobile/ac/ac1.recipe.json',
    'ac/ac1.mobile.recipe.json',
    'cli/ac/ac1.recipe.json',
  ])
    assert.equal(recipeShapeLibraryRef(null, file, ['cli']), 'ac.ac1', file);
  assert.equal(recipeShapeLibraryRef('proof', 'shared/ac/ac1.recipe.json'), 'proof.ac.ac1');
  assert.equal(recipeShapeLibraryRef(null, 'shared/ac/ac1.mobile.recipe.json'), null);
  assert.equal(recipeShapeLibraryRef(null, 'recipe-library.json'), null);
});
