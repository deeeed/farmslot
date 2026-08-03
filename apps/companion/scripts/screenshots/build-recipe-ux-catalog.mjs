#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildRecipeReviewBoard } from '@farmslot/recipe-harness/visual-review';

export const COMPANION_SURFACE_LOCATIONS = {
  'capture-review': '/(tabs)/runs',
  'capture-terminals': '/(tabs)/workers',
  'capture-advanced': '/(tabs)/advanced',
  'capture-settings': '/(tabs)/settings',
  'capture-fleet': '/(tabs)/fleet',
  'capture-prs': '/(tabs)/prs',
  'capture-inbox': '/(tabs)/inbox',
  'capture-run': '/run/[id]',
  'capture-ready-gate': '/decision/[id]',
  'capture-ready-evidence': '/decision/[id]',
  'capture-ready-timeline': '/decision/[id]',
  'capture-ready-diff': '/diff/[runId]',
};

export function buildRecipeUxCatalog({ artifactsDir, outputDir, platform, recipePath }) {
  return buildRecipeReviewBoard({
    artifactsDir,
    outputDir,
    platform,
    recipePath,
    sourceId: 'farmslot-farm:companion-ux-catalog',
    project: 'farmslot-farm',
    runId: process.env.FARMSLOT_RUN_ID,
    surfaceLocations: COMPANION_SURFACE_LOCATIONS,
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
