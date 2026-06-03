import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
} from './artifact-url';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  artifactWorkspaceNavCurrent,
  decisionWorkspaceRouteParams,
  familyRouteContextForWorkspaceNav,
  familySectionParamForWorkspaceNav,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForDecisionEvidenceContext,
  shouldPreserveArtifactForDiffContext,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceForArtifactRoute,
  targetWorkspaceRouteContextParams,
  terminalDetailsParamForWorkspaceNav,
  workspaceArtifactPathParam,
  workspaceForFamilySection,
  workspaceNavCurrentForRoute,
  workspaceRouteContextParams,
  workspaceSignalTargetForDecisionLabel,
} from './workspace-navigation';

test('workspaceNavCurrentForRoute promotes workspace focus without preserving physical origins', () => {
  assert.equal(workspaceNavCurrentForRoute('slot', 'ready'), 'ready');
  assert.equal(workspaceNavCurrentForRoute('run', 'review'), 'review');
  assert.equal(workspaceNavCurrentForRoute('family', 'retro'), 'retro');
  assert.equal(workspaceNavCurrentForRoute('slot', 'compare'), 'compare');
  assert.equal(workspaceNavCurrentForRoute('run', 'recipe'), 'recipe');
  assert.equal(workspaceNavCurrentForRoute('run', 'slot'), 'run');
  assert.equal(workspaceNavCurrentForRoute('family', 'run'), 'family');
  assert.equal(workspaceNavCurrentForRoute('slot', undefined), 'slot');
});

test('workspaceForFamilySection maps family sections to workspace focus', () => {
  assert.equal(workspaceForFamilySection('compare'), 'compare');
  assert.equal(workspaceForFamilySection('ledger'), 'diff');
  assert.equal(workspaceForFamilySection('retros'), 'retro');
  assert.equal(workspaceForFamilySection('evidence'), 'artifacts');
  assert.equal(workspaceForFamilySection('runs'), 'run');
  assert.equal(workspaceForFamilySection('focus'), 'family');
  assert.equal(workspaceForFamilySection('unknown'), undefined);
});

test('familySectionRouteContextParams builds section-aligned workspace context', () => {
  assert.deepEqual(familySectionRouteContextParams('evidence'), { workspace: 'artifacts' });
  assert.deepEqual(familySectionRouteContextParams('compare'), { workspace: 'compare' });
  assert.deepEqual(familySectionRouteContextParams('ledger'), { workspace: 'diff' });
  assert.deepEqual(familySectionRouteContextParams('retros'), { workspace: 'retro' });
  assert.deepEqual(familySectionRouteContextParams('focus'), { workspace: 'family' });
  assert.deepEqual(familySectionRouteContextParams('retros', 'review'), {
    workspace: 'retro',
    decisionKind: 'review',
  });
  assert.deepEqual(familySectionRouteContextParams('evidence', 'ready'), {
    workspace: 'artifacts',
    decisionKind: 'ready',
  });
  assert.deepEqual(familySectionRouteContextParams('unknown', 'review'), {
    workspace: 'family',
    decisionKind: 'review',
  });
});

test('familyRouteContextForWorkspaceNav routes family links to matching family sections', () => {
  assert.deepEqual(familyRouteContextForWorkspaceNav('artifacts'), { workspace: 'artifacts' });
  assert.deepEqual(familyRouteContextForWorkspaceNav('compare'), { workspace: 'compare' });
  assert.deepEqual(familyRouteContextForWorkspaceNav('diff'), { workspace: 'diff' });
  assert.deepEqual(familyRouteContextForWorkspaceNav('retro'), { workspace: 'retro' });
  assert.deepEqual(familyRouteContextForWorkspaceNav('terminal', 'review'), {
    workspace: 'family',
    decisionKind: 'review',
  });
});

test('targetWorkspaceRouteContextParams aligns workspace nav links with their destination', () => {
  assert.deepEqual(targetWorkspaceRouteContextParams('terminal'), { workspace: 'terminal' });
  assert.deepEqual(targetWorkspaceRouteContextParams('artifacts', 'review'), {
    workspace: 'artifacts',
    decisionKind: 'review',
  });
  assert.deepEqual(targetWorkspaceRouteContextParams('diff'), { workspace: 'diff' });
  assert.deepEqual(targetWorkspaceRouteContextParams('diff', 'retrospective'), {
    workspace: 'diff',
    decisionKind: 'retrospective',
  });
});

test('targetWorkspaceForArtifactRoute derives artifact destination workspace', () => {
  assert.equal(targetWorkspaceForArtifactRoute(null, 'review'), 'artifacts');
  assert.equal(targetWorkspaceForArtifactRoute(null, 'visual'), 'compare');
  assert.equal(targetWorkspaceForArtifactRoute('recipe-run-1', undefined), 'recipe');
  assert.equal(
    targetWorkspaceForArtifactRoute(DECISION_EVIDENCE_RECIPE_RUN_PARAM, 'recipes'),
    'recipe',
  );
});

test('workspaceRouteContextParams preserves valid workspace route focus', () => {
  assert.deepEqual(workspaceRouteContextParams(' ready ', ' no_change '), {
    workspace: 'ready',
    decisionKind: 'no_change',
  });
  assert.deepEqual(workspaceRouteContextParams('diff', undefined), { workspace: 'diff' });
  assert.deepEqual(workspaceRouteContextParams('unknown', 'review', 'terminal'), {
    workspace: 'terminal',
    decisionKind: 'review',
  });
  assert.deepEqual(workspaceRouteContextParams('', '', undefined), {});
});

test('decisionWorkspaceRouteParams preserves ready review and retro route focus', () => {
  assert.deepEqual(decisionWorkspaceRouteParams('ready'), {
    workspace: 'ready',
    decisionKind: 'ready',
  });
  assert.deepEqual(decisionWorkspaceRouteParams('review'), {
    workspace: 'review',
    decisionKind: 'review',
  });
  assert.deepEqual(decisionWorkspaceRouteParams('no_change'), {
    workspace: 'review',
    decisionKind: 'no-change',
  });
  assert.deepEqual(decisionWorkspaceRouteParams('retrospective'), {
    workspace: 'retro',
    decisionKind: 'retrospective',
  });
  assert.deepEqual(decisionWorkspaceRouteParams('collision'), {});
  assert.deepEqual(decisionWorkspaceRouteParams(null), {});
});

test('recipeWorkspaceParam routes decision evidence context back to current recipe artifacts', () => {
  assert.equal(
    recipeWorkspaceParam(DECISION_EVIDENCE_RECIPE_RUN_PARAM),
    CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  );
  assert.equal(recipeWorkspaceParam(null), CURRENT_ARTIFACTS_RECIPE_RUN_PARAM);
  assert.equal(recipeWorkspaceParam(' '), CURRENT_ARTIFACTS_RECIPE_RUN_PARAM);
});

test('recipeWorkspaceParam preserves explicit recipe run selections', () => {
  assert.equal(recipeWorkspaceParam('live-run:abc'), 'live-run:abc');
  assert.equal(recipeWorkspaceParam(' current-artifacts '), CURRENT_ARTIFACTS_RECIPE_RUN_PARAM);
});

test('recipeWorkspaceScopeLabel distinguishes current recipes from selected recipe runs', () => {
  assert.equal(recipeWorkspaceScopeLabel(null), 'current');
  assert.equal(recipeWorkspaceScopeLabel(DECISION_EVIDENCE_RECIPE_RUN_PARAM), 'current');
  assert.equal(recipeWorkspaceScopeLabel(CURRENT_ARTIFACTS_RECIPE_RUN_PARAM), 'current');
  assert.equal(recipeWorkspaceScopeLabel(' live-run:abc '), 'selected');
});

test('shouldPreserveArtifactForRecipeContext keeps focused artifacts only inside recipe scopes', () => {
  assert.equal(
    shouldPreserveArtifactForRecipeContext(
      DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      'artifacts/review.md',
    ),
    false,
  );
  assert.equal(shouldPreserveArtifactForRecipeContext(null, 'artifacts/diff.txt'), false);
  assert.equal(
    shouldPreserveArtifactForRecipeContext('current-artifacts', 'artifacts/recipe.json'),
    true,
  );
  assert.equal(shouldPreserveArtifactForRecipeContext('live-run:abc', 'artifacts/after.png'), true);
  assert.equal(shouldPreserveArtifactForRecipeContext('live-run:abc', ' '), false);
});

test('shouldPreserveArtifactForDecisionEvidenceContext keeps focused artifacts only inside decision scopes', () => {
  assert.equal(
    shouldPreserveArtifactForDecisionEvidenceContext(
      DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      'artifacts/review.md',
    ),
    true,
  );
  assert.equal(shouldPreserveArtifactForDecisionEvidenceContext(null, 'artifacts/diff.txt'), true);
  assert.equal(shouldPreserveArtifactForDecisionEvidenceContext(null, ' '), false);
  assert.equal(
    shouldPreserveArtifactForDecisionEvidenceContext(
      CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
      'artifacts/recipe.json',
    ),
    false,
  );
  assert.equal(
    shouldPreserveArtifactForDecisionEvidenceContext('live-run:abc', 'artifacts/after.png'),
    false,
  );
});

test('terminalDetailsParamForWorkspaceNav opens terminal cockpit from workspace navigation', () => {
  assert.equal(terminalDetailsParamForWorkspaceNav('artifacts'), '1');
  assert.equal(terminalDetailsParamForWorkspaceNav('diff'), '1');
  assert.equal(terminalDetailsParamForWorkspaceNav('slot'), '1');
  assert.equal(terminalDetailsParamForWorkspaceNav('terminal'), undefined);
  assert.equal(terminalDetailsParamForWorkspaceNav(null), undefined);
});

test('workspaceArtifactPathParam preserves focused artifacts across workspace links', () => {
  assert.equal(workspaceArtifactPathParam(' artifacts/review.md '), 'artifacts/review.md');
  assert.equal(workspaceArtifactPathParam(''), undefined);
  assert.equal(workspaceArtifactPathParam('   '), undefined);
  assert.equal(workspaceArtifactPathParam(null), undefined);
});

test('familySectionParamForWorkspaceNav preserves workspace context for family links', () => {
  assert.equal(familySectionParamForWorkspaceNav('compare'), 'compare');
  assert.equal(familySectionParamForWorkspaceNav('artifacts'), 'evidence');
  assert.equal(familySectionParamForWorkspaceNav('diff'), 'ledger');
  assert.equal(familySectionParamForWorkspaceNav('retro'), 'retros');
  assert.equal(familySectionParamForWorkspaceNav('ready'), 'focus');
  assert.equal(familySectionParamForWorkspaceNav('review'), 'focus');
  assert.equal(familySectionParamForWorkspaceNav('recipe'), 'focus');
  assert.equal(familySectionParamForWorkspaceNav('slot'), 'focus');
  assert.equal(familySectionParamForWorkspaceNav('terminal'), 'focus');
  assert.equal(familySectionParamForWorkspaceNav('pr'), 'focus');
  assert.equal(familySectionParamForWorkspaceNav(null), undefined);
});

test('artifactFilterParamForWorkspaceNav preserves workspace context for artifact links', () => {
  assert.equal(artifactFilterParamForWorkspaceNav('ready'), 'review');
  assert.equal(artifactFilterParamForWorkspaceNav('review'), 'review');
  assert.equal(artifactFilterParamForWorkspaceNav('retro'), 'review');
  assert.equal(artifactFilterParamForWorkspaceNav('diff'), 'diffs');
  assert.equal(artifactFilterParamForWorkspaceNav('recipe'), 'recipes');
  assert.equal(artifactFilterParamForWorkspaceNav('compare'), 'visual');
  assert.equal(artifactFilterParamForWorkspaceNav('run'), undefined);
  assert.equal(artifactFilterParamForWorkspaceNav(null), undefined);
});

test('artifactFilterParamForArtifactPath infers useful artifact filters', () => {
  assert.equal(artifactFilterParamForArtifactPath('inputs/diff.txt'), 'diffs');
  assert.equal(artifactFilterParamForArtifactPath('reports/fix.patch'), 'diffs');
  assert.equal(artifactFilterParamForArtifactPath('recipe/output.json'), 'recipes');
  assert.equal(artifactFilterParamForArtifactPath('artifacts/recipe.json'), 'recipes');
  assert.equal(artifactFilterParamForArtifactPath('screens/after-login.png'), 'visual');
  assert.equal(artifactFilterParamForArtifactPath('video/replay.mp4'), 'visual');
  assert.equal(artifactFilterParamForArtifactPath('logs/worker.txt'), undefined);
  assert.equal(artifactFilterParamForArtifactPath(null), undefined);
});

test('artifactWorkspaceNavCurrent reflects compare and recipe artifact contexts', () => {
  assert.equal(artifactWorkspaceNavCurrent(null, 'visual', 2), 'compare');
  assert.equal(
    artifactWorkspaceNavCurrent(DECISION_EVIDENCE_RECIPE_RUN_PARAM, 'visual', 0),
    'artifacts',
  );
  assert.equal(artifactWorkspaceNavCurrent('live-run:abc', 'visual', 2), 'compare');
  assert.equal(artifactWorkspaceNavCurrent('live-run:abc', 'review', 2), 'recipe');
  assert.equal(artifactWorkspaceNavCurrent(null, 'recipes', 0), 'recipe');
  assert.equal(
    artifactWorkspaceNavCurrent(DECISION_EVIDENCE_RECIPE_RUN_PARAM, 'review', 1),
    'artifacts',
  );
});

test('workspaceSignalTargetForDecisionLabel maps review chips to focused workspaces', () => {
  assert.equal(workspaceSignalTargetForDecisionLabel('Diff'), 'diff');
  assert.equal(workspaceSignalTargetForDecisionLabel('Evidence'), 'artifacts');
  assert.equal(workspaceSignalTargetForDecisionLabel('Visual pairs'), 'compare');
  assert.equal(workspaceSignalTargetForDecisionLabel('Before→After'), 'compare');
  assert.equal(workspaceSignalTargetForDecisionLabel('Before/After'), 'compare');
  assert.equal(workspaceSignalTargetForDecisionLabel('Verdict'), null);
});

test('shouldPreserveArtifactForDiffContext keeps only renderable diff-like artifact paths', () => {
  assert.equal(shouldPreserveArtifactForDiffContext('inputs/diff.txt'), true);
  assert.equal(shouldPreserveArtifactForDiffContext('review/fix.patch'), true);
  assert.equal(shouldPreserveArtifactForDiffContext('artifacts/diff-stat.json'), false);
  assert.equal(shouldPreserveArtifactForDiffContext('artifacts/screenshot-after.png'), false);
  assert.equal(shouldPreserveArtifactForDiffContext('reports/recipe.json'), false);
  assert.equal(shouldPreserveArtifactForDiffContext(' '), false);
  assert.equal(shouldPreserveArtifactForDiffContext(null), false);
});
