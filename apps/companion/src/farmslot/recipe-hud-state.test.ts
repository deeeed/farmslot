import assert from 'node:assert/strict';
import test from 'node:test';

import type { RecipeFlowUpdate } from '@farmslot/protocol/recipe';

import { formatRecipeHudIntent, normalizeHudState } from './recipe-hud-state';

const flow: RecipeFlowUpdate = {
  version: 1,
  recipeRunId: 'execution-1',
  rootId: '$root',
  activeId: 'second/child',
  ancestry: {
    parentId: 'second',
    depth: 2,
    breadcrumbs: [
      { id: '$root', label: 'Recipe' },
      { id: 'second', label: 'Repeat checkout' },
      { id: 'second/child', label: 'Open Review' },
    ],
  },
  progress: { current: 4, completed: 3, total: null, remaining: null, qualification: 'unknown' },
};

test('Companion HUD keeps SDK ancestry and uses SDK progress instead of legacy totals', () => {
  const hud = normalizeHudState({
    intent: 'Check the Review queue',
    currentStep: 1,
    totalSteps: 20,
    recipe_flow: flow,
  });

  assert.equal(hud.intent, 'Check the Review queue');
  assert.equal(hud.recipeFlow, flow);
  assert.equal(
    formatRecipeHudIntent(hud),
    'Check the Review queue · Recipe › Repeat checkout › Open Review',
  );
  assert.equal(hud.currentStep, 4);
  assert.equal(hud.totalSteps, undefined);
  assert.equal(hud.recipeFlow?.progress.remaining, null);
});

test('Companion HUD retains legacy and final captions', () => {
  const legacy = { intent: 'Unchanged caption', progress: { current: 2, total: 8 } };
  const fallback = normalizeHudState({ ...legacy, recipe_flow: { ...flow, activeId: 'invalid' } });
  assert.equal(fallback.currentStep, 2);
  assert.equal(fallback.totalSteps, 8);
  assert.equal(fallback.recipeFlow, undefined);
  assert.equal(formatRecipeHudIntent(fallback), legacy.intent);

  const completion = normalizeHudState({
    status: 'pass',
    text: 'Recipe completed',
    recipe_flow: {
      ...flow,
      activeId: null,
      ancestry: null,
      progress: { current: 11, completed: 11, total: 11, remaining: 0, qualification: 'exact' },
    },
  });
  assert.equal(completion.currentStep, 11);
  assert.equal(completion.totalSteps, 11);
  assert.equal(formatRecipeHudIntent(completion), 'Recipe completed');
});
