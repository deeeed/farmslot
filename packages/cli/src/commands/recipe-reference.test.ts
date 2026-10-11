import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { recipeCliReferenceSitePage, renderRecipeCliReference } from './recipe-reference.js';

test('published recipe reference matches the command grammar', () => {
  assert.equal(
    readFileSync(new URL('../../../../docs/reference/recipe-cli.md', import.meta.url), 'utf8'),
    renderRecipeCliReference(),
  );
  assert.equal(
    readFileSync(
      new URL('../../../../apps/docs/docs/reference/recipe-cli.md', import.meta.url),
      'utf8',
    ),
    recipeCliReferenceSitePage(),
  );
});
