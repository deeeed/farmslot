import assert from 'node:assert/strict';
import test from 'node:test';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

test('recipe module exposes only the public recipe protocol surface', async () => {
  const facade = await import('../../src/recipe/index.js');
  assert.deepEqual(Object.keys(facade).sort(), [
    'OFFICIAL_RECIPE_ACTIONS',
    'RECIPE_PLAYBACK_SLOW_MS_MAX',
    'RECIPE_PLAYBACK_SLOW_MS_MIN',
    'RECIPE_PROTOCOL_SCHEMA_URL',
    'RECIPE_PROTOCOL_SCHEMA_URLS',
    'RECIPE_PROTOCOL_SCHEMA_VERSION',
    'getRecipeActionManifestActionNames',
    'getRecipeWorkflowActions',
    'getRecipeWorkflowNodeIds',
    'isRecord',
    'mergeRecipeValidationResults',
    'recipeProtocolSchemaUrlForVersion',
    'validateArtifactManifestDocument',
    'validateRecipeActionManifestDocument',
    'validateRecipeArtifactPackage',
    'validateRecipeDocument',
    'validateRecipeWithManifest',
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
