import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recipeCliReferenceSitePage,
  renderRecipeCliReference,
} from '../../../packages/cli/src/commands/recipe-reference.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pages = [
  ['docs/reference/recipe-cli.md', renderRecipeCliReference()],
  ['apps/docs/docs/reference/recipe-cli.md', recipeCliReferenceSitePage()],
] as const;
for (const [relative, content] of pages) {
  const file = path.join(root, relative);
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== content)
      throw new Error(`Stale generated reference: ${relative}`);
  } else writeFileSync(file, content);
}
