import assert from 'node:assert/strict';
import test from 'node:test';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

test('recipe module exposes only the public recipe protocol surface', async () => {
  const facade = await import('../../src/recipe/index.js');
  assert.deepEqual(Object.keys(facade).sort(), [
    'BUILT_IN_UI_OBSERVERS',
    'DEFAULT_UNTRUSTED_RECIPE_BLOCKED_CAPABILITIES',
    'OFFICIAL_RECIPE_ACTIONS',
    'RECIPE_ACTION_MANIFEST_SCHEMA_URL',
    'RECIPE_EXECUTION_CAPABILITIES',
    'RECIPE_FAILURE_CAUSES',
    'RECIPE_PROTOCOL_SCHEMA_URL',
    'RECIPE_PROTOCOL_SCHEMA_URLS',
    'RECIPE_PROTOCOL_SCHEMA_VERSION',
    'RECIPE_SUITE_NON_EXECUTION_REASONS',
    'RECIPE_SUITE_RESULT_SCHEMA_URL',
    'RECIPE_SUITE_SCOPE_SCHEMA_URL',
    'applyRecipeParamDefaults',
    'canonicalRecipeJson',
    'digestRecipeDocument',
    'digestRecipeSuiteScope',
    'getRecipeActionManifestActionNames',
    'getRecipeCallRefs',
    'getRecipeWorkflowActions',
    'getRecipeWorkflowNodeIds',
    'isDynamicRecipeRef',
    'isRecord',
    'mergeRecipeValidationResults',
    'normalizeRecipeRef',
    'officialRecipeActionCapabilities',
    'recipeProtocolSchemaUrlForVersion',
    'resolvedRecipeArtifactPath',
    'validateArtifactManifestDocument',
    'validateRecipeActionManifestDocument',
    'validateRecipeArtifactPackage',
    'validateRecipeDocument',
    'validateRecipeParams',
    'validateRecipeParamsSchema',
    'validateRecipeSuitePackage',
    'validateRecipeSuiteResultDocument',
    'validateRecipeSuiteScopeDocument',
    'validateRecipeWithManifest',
    'validateResolvedRecipeActionNode',
  ]);
});

test('recipe internals are not package-exported subpaths', async () => {
  const packageFacade = await dynamicImport('@farmslot/protocol/recipe');
  assert.equal(typeof packageFacade.validateRecipeDocument, 'function');

  await assert.rejects(
    dynamicImport('@farmslot/protocol/recipe/common'),
    /Package subpath|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED/,
  );
});
