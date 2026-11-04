import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateRecipeActionManifestDocument,
  validateRecipeDocument,
  validateRecipeWithManifest,
} from '@farmslot/protocol/recipe';
import { type RawProjectJson, validateRuntimeCapabilitiesConfig } from '@farmslot/slot-config';

import { validatePackDir } from './pack.js';

const pack = fileURLToPath(new URL('../../../../packs/siteed-web-farm/', import.meta.url));

test('the website pack passes real onboarding validation without operator pool configuration', () => {
  const result = validatePackDir(pack, join(tmpdir(), 'siteed-web-no-operator-pool'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.pack?.projects[0].platform, 'cli');
});

test('the bundled website smoke is a valid proof recipe before any browser is acquired', () => {
  const recipe: unknown = JSON.parse(
    readFileSync(
      join(pack, 'projects/siteed-web-farm/fixtures/recipe-provider/recipes/web/smoke.recipe.json'),
      'utf8',
    ),
  );
  const result = validateRecipeDocument(recipe);
  assert.equal(result.status, 'valid', JSON.stringify(result));
});

test('the website action manifest examples pass the shared schema and intent checks', () => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      join(pack, 'projects/siteed-web-farm/fixtures/recipe-provider/web.action-manifest.json'),
      'utf8',
    ),
  );
  const result = validateRecipeActionManifestDocument(manifest);
  assert.equal(result.status, 'valid', JSON.stringify(result));
});

test('the bundled proof plans against its actual action manifest and lifecycle resource references', () => {
  const projectRoot = join(pack, 'projects/siteed-web-farm');
  const project: RawProjectJson = JSON.parse(
    readFileSync(join(projectRoot, 'project.json'), 'utf8'),
  );
  assert.doesNotThrow(() =>
    validateRuntimeCapabilitiesConfig(project, 'siteed-web-farm/project.json'),
  );
  const recipe: unknown = JSON.parse(
    readFileSync(
      join(projectRoot, 'fixtures/recipe-provider/recipes/web/smoke.recipe.json'),
      'utf8',
    ),
  );
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, 'fixtures/recipe-provider/web.action-manifest.json'), 'utf8'),
  );
  const result = validateRecipeWithManifest(recipe, manifest);
  assert.equal(result.status, 'valid', JSON.stringify(result));
});
