#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildRecipeReviewBoard } from '@farmslot/recipe-harness/visual-review';

export function buildRecipeUxCatalog({ artifactsDir, outputDir, platform, recipePath }) {
  return buildRecipeReviewBoard({
    artifactsDir,
    outputDir,
    platform,
    recipePath,
    sourceId: 'farmslot-farm:companion-ux-catalog',
    project: 'farmslot-farm',
    title: 'Companion UX catalog',
    storageKey: 'farmslot-companion-ux-feedback',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [artifactsDir, outputDir, platform, recipePath] = process.argv.slice(2);
  if (!artifactsDir || !outputDir || !platform || !recipePath) {
    throw new Error(
      'Usage: build-recipe-ux-catalog.mjs <recipe-artifacts-dir> <output-dir> <platform> <recipe-path>',
    );
  }
  buildRecipeUxCatalog({ artifactsDir, outputDir, platform, recipePath });
}
