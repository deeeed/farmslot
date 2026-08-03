#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { generateReviewBoard } from '@farmslot/recipe-harness/visual-review';

export function generateUxCatalog(outputArg, options = {}) {
  const outputDir = path.resolve(outputArg);
  const manifest = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
  const selectedIds = new Set(options.surfaceIds ?? []);
  const routes = manifest.routes ?? [];
  const missingIds = [...selectedIds].filter((id) => !routes.some((route) => route.id === id));
  if (missingIds.length > 0) {
    throw new Error(
      `Unknown catalog screen${missingIds.length === 1 ? '' : 's'}: ${missingIds.join(', ')}`,
    );
  }
  const includedRoutes = routes.filter(
    (route) => selectedIds.size === 0 || selectedIds.has(route.id),
  );
  const includedIds = new Set(includedRoutes.map((route) => route.id));
  const surfaces = includedRoutes
    .map((route) => ({
      id: route.id,
      title: route.title,
      location: route.path,
      ...(route.nodeId ? { nodeId: route.nodeId } : {}),
      ...(route.proofTargets ? { proofTargets: route.proofTargets } : {}),
      ...(route.parentId && includedIds.has(route.parentId) ? { parentId: route.parentId } : {}),
      ...(route.relatedSurfaceIds
        ? { relatedSurfaceIds: route.relatedSurfaceIds.filter((id) => includedIds.has(id)) }
        : {}),
      captures: Object.entries(route.images ?? {})
        .map(([platform, imagePath]) => ({
          id: `${platform}-${route.id}`,
          platform,
          image: {
            path: imagePath,
            mimeType: 'image/png',
          },
        }))
        .filter((capture) => existsSync(path.join(outputDir, capture.image.path))),
    }))
    .filter((surface) => surface.captures.length > 0);

  const source = {
    version: 1,
    kind: 'visual-review-source',
    id: manifest.id ?? 'farmslot-farm:companion-ux-catalog',
    title: manifest.title ?? 'Companion UX catalog',
    capturedAt: manifest.capturedAt,
    description: `${manifest.variant} · ${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}`,
    project: manifest.project ?? 'farmslot-farm',
    surfaces,
  };

  generateReviewBoard({
    outputDir,
    source,
    storageKey: 'farmslot-companion-ux-feedback',
    defaultPlatform: options.defaultPlatform ?? surfaces[0]?.captures[0]?.platform,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outputArg = args.shift();
  if (!outputArg) {
    throw new Error('Usage: generate-ux-catalog.mjs <screenshot-dir> [--surface <surface-id>]…');
  }
  const surfaceIds = [];
  while (args.length > 0) {
    const flag = args.shift();
    if (!['--surface', '--screen'].includes(flag) || !args[0]) {
      throw new Error(`Unknown or incomplete option: ${flag ?? ''}`);
    }
    surfaceIds.push(args.shift());
  }
  generateUxCatalog(outputArg, { surfaceIds });
}
