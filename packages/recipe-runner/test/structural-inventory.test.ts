import assert from 'node:assert/strict';
import test from 'node:test';

import { digestRecipeDocument } from '@farmslot/protocol';

import {
  buildRecipeInvocationTree,
  buildRecipeStructuralInventory,
  RecipeResolutionError,
  type RecipeStructuralInventoryInput,
  type ResolvedLibraryRecipe,
  resolveRecipeDependencies,
  rootResolutionRef,
} from '../src/index.js';

import { inner, root, unit } from './flow.fixture.js';

async function input(
  document: Record<string, unknown>,
  entries: ReadonlyArray<readonly [string, Record<string, unknown>]> = [],
): Promise<RecipeStructuralInventoryInput> {
  const recipes = new Map<string, ResolvedLibraryRecipe>();
  for (const [ref, recipe] of entries) {
    recipes.set(ref, {
      ref,
      document: recipe,
      source: 'fixture',
      file: ref + '.recipe.json',
      path: '/fixture/' + ref + '.recipe.json',
      provenance: { kind: 'library', trust: 'unknown', digest: await digestRecipeDocument(recipe) },
      shadows: [],
    });
  }
  const digest = await digestRecipeDocument(document);
  return {
    root: document,
    dependencies: resolveRecipeDependencies({
      rootRef: rootResolutionRef(digest),
      root: document,
      rootSource: { kind: 'library', trust: 'unknown', digest },
      recipes,
    }),
  };
}

const sourceDigestMismatch = (error: unknown): boolean =>
  error instanceof RecipeResolutionError &&
  error.code === 'RECIPE_RESOLUTION_DIGEST_MISMATCH' &&
  /reload/.test(error.userAction);

const health = {
  workflow: {
    entry: 'observe',
    nodes: {
      observe: { action: 'command', next: 'choose' },
      choose: { action: 'switch', cases: { connected: 'wait' }, default: 'check' },
      wait: { action: 'wait', next: 'check' },
      check: { action: 'assert_output', next: 'capture' },
      capture: { action: 'ui.screenshot', next: 'done' },
      done: { action: 'end', status: 'pass' },
    },
  },
};

test('public inventory keeps the existing resolution and tree, with no timing or input effects', async () => {
  const fixture = await input(health);
  const before = structuredClone(fixture);
  const inventory = buildRecipeStructuralInventory(fixture);
  assert.equal(inventory.version, 1);
  assert.deepEqual(inventory.resolution, fixture.dependencies.document);
  assert.deepEqual(
    inventory.tree,
    buildRecipeInvocationTree({
      root: fixture.root,
      rootRef: fixture.dependencies.document.root.ref,
      recipes: fixture.dependencies.recipes,
    }),
  );
  assert.deepEqual(inventory.counts, {
    nodeCount: 5,
    branchCount: 1,
    callCount: 0,
    recipeCount: 1,
    teardownEntryCount: 0,
  });
  assert.equal('timing' in inventory, false);
  assert.deepEqual(fixture, before);
});

test('repeated nested calls expand per invocation and include every branch and teardown once', async () => {
  const fixture = await input(root, [
    ['fixture.inner', inner],
    ['fixture.unit', unit],
  ]);
  const inventory = buildRecipeStructuralInventory(fixture);
  assert.deepEqual(inventory.counts, {
    nodeCount: 13,
    branchCount: 1,
    callCount: 4,
    recipeCount: 3,
    teardownEntryCount: 3,
  });
  assert.equal(inventory.tree.nodes.length, 26);
  assert.deepEqual(
    inventory.tree.nodes
      .filter((node) => node.id !== inventory.tree.rootId && node.action === 'call')
      .map((node) => node.id),
    ['first', 'first/nested', 'second', 'second/nested'],
  );
  assert.equal(
    fixture.dependencies.document.edges.length,
    3,
    'dependency edges are not expanded call-site counts',
  );
  assert.ok(inventory.tree.nodes.some((node) => node.id === 'accept'));
  assert.ok(inventory.tree.nodes.some((node) => node.id === 'reject_extra'));
});

test('converging case and default edges do not multiply shared work', async () => {
  const fixture = await input({
    workflow: {
      entry: 'choose',
      nodes: {
        choose: { action: 'switch', cases: { one: 'shared', two: 'shared' }, default: 'shared' },
        shared: { action: 'wait', next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  assert.deepEqual(buildRecipeStructuralInventory(fixture).counts, {
    nodeCount: 2,
    branchCount: 1,
    callCount: 0,
    recipeCount: 1,
    teardownEntryCount: 0,
  });
});

test('an end-only main path keeps known zero work and counts teardown independently', async () => {
  const empty = await input({
    workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
  });
  assert.deepEqual(buildRecipeStructuralInventory(empty).counts, {
    nodeCount: 0,
    branchCount: 0,
    callCount: 0,
    recipeCount: 1,
    teardownEntryCount: 0,
  });
  const cleanup = await input({
    workflow: {
      entry: 'done',
      teardown: 'release',
      nodes: {
        done: { action: 'end', status: 'pass' },
        release: { action: 'wait', next: 'clean' },
        clean: { action: 'end', status: 'pass' },
      },
    },
  });
  assert.deepEqual(buildRecipeStructuralInventory(cleanup).counts, {
    nodeCount: 1,
    branchCount: 0,
    callCount: 0,
    recipeCount: 1,
    teardownEntryCount: 1,
  });
});

test('missing resolved children fail instead of silently producing zero inventory', async () => {
  const fixture = await input(root, [
    ['fixture.inner', inner],
    ['fixture.unit', unit],
  ]);
  assert.throws(
    () =>
      buildRecipeStructuralInventory({
        ...fixture,
        dependencies: { ...fixture.dependencies, recipes: new Map() },
      }),
    sourceDigestMismatch,
  );
});

test('existing checked claim projections pass through without changing structural counts', async () => {
  const fixture = await input(root, [
    ['fixture.inner', inner],
    ['fixture.unit', unit],
  ]);
  const result = buildRecipeStructuralInventory({
    ...fixture,
    claimProjections: new Map([['first/nested/read', { proves: ['AC-shared'] }]]),
  });
  assert.deepEqual(result.tree.nodes.find((node) => node.id === 'first/nested/read')?.claimIds, [
    'AC-shared',
  ]);
  assert.equal(result.counts.nodeCount, 13);
});

test('a root from another source revision cannot reuse an older resolution identity', async () => {
  const fixture = await input(health);
  assert.throws(
    () =>
      buildRecipeStructuralInventory({
        ...fixture,
        root: { ...fixture.root, title: 'Changed source revision' },
      }),
    /source digest/,
  );
});

test('a changed child document cannot reuse an older resolved dependency digest', async () => {
  const fixture = await input(root, [
    ['fixture.inner', inner],
    ['fixture.unit', unit],
  ]);
  const child = fixture.dependencies.recipes.get('fixture.unit');
  assert.ok(child);
  const recipes = new Map(fixture.dependencies.recipes);
  recipes.set(child.ref, {
    ...child,
    document: { ...child.document, description: 'Changed child revision' },
  });
  assert.throws(
    () =>
      buildRecipeStructuralInventory({
        ...fixture,
        dependencies: { ...fixture.dependencies, recipes },
      }),
    /source digest/,
  );
});

test('a stale nested target reports a typed digest mismatch before dependency expansion', async () => {
  const fixture = await input(root, [
    ['fixture.inner', inner],
    ['fixture.unit', unit],
  ]);
  const child = fixture.dependencies.recipes.get('fixture.unit');
  assert.ok(child);
  const edited = {
    ...unit,
    workflow: {
      ...unit.workflow,
      nodes: {
        ...unit.workflow.nodes,
        nested: { ...unit.workflow.nodes.nested, ref: 'fixture.replacement' },
      },
    },
  };
  const staleRecipes = new Map(fixture.dependencies.recipes);
  staleRecipes.set(child.ref, { ...child, document: edited });
  assert.throws(
    () =>
      buildRecipeStructuralInventory({
        ...fixture,
        dependencies: { ...fixture.dependencies, recipes: staleRecipes },
      }),
    sourceDigestMismatch,
  );
  const refreshed = await input(root, [
    ['fixture.unit', edited],
    ['fixture.replacement', inner],
  ]);
  assert.deepEqual(buildRecipeStructuralInventory(refreshed).counts, {
    nodeCount: 13,
    branchCount: 1,
    callCount: 4,
    recipeCount: 3,
    teardownEntryCount: 3,
  });
});
