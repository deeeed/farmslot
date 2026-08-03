#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildRecipeReviewBoard,
  generateReviewBoard,
  serveReviewBoard,
} from '../visual-review/index.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function options(args, name) {
  const values = [];
  let index = args.indexOf(name);
  while (index !== -1) {
    if (!args[index + 1]) throw new Error(`${name} requires a value.`);
    values.push(args[index + 1]);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
  return values;
}

function usage() {
  return [
    'Usage:',
    '  farmslot-visual-review <build|serve> <visual-review-source.json> [--surface <id>]… [--output <dir>] [--host <host>] [--port <port>]',
    '  farmslot-visual-review build-recipe <recipe.json> --artifacts <dir> --platform <name> --source-id <project:catalog> [--project <id>] [--title <title>] [--output <dir>]',
  ].join('\n');
}

function selectSourceSurfaces(source, surfaceIds) {
  if (surfaceIds.length === 0) return source;
  const selected = new Set(surfaceIds);
  const missing = surfaceIds.filter((id) => !source.surfaces.some((surface) => surface.id === id));
  if (missing.length > 0) throw new Error(`Unknown review surface: ${missing.join(', ')}`);
  return {
    ...source,
    surfaces: source.surfaces
      .filter((surface) => selected.has(surface.id))
      .map((surface) => ({
        ...surface,
        ...(surface.parentId && !selected.has(surface.parentId) ? { parentId: undefined } : {}),
        ...(surface.relatedSurfaceIds
          ? { relatedSurfaceIds: surface.relatedSurfaceIds.filter((id) => selected.has(id)) }
          : {}),
      })),
    ...(source.navigationEdges
      ? {
          navigationEdges: source.navigationEdges.filter(
            (edge) => selected.has(edge.fromSurfaceId) && selected.has(edge.toSurfaceId),
          ),
        }
      : {}),
  };
}

function resolveInside(root, relativePath, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} must stay inside ${resolvedRoot}.`);
  }
  return resolvedPath;
}

function copySourceImages(source, sourceDir, outputDir) {
  if (path.resolve(sourceDir) === path.resolve(outputDir)) return;
  for (const capture of source.surfaces.flatMap((surface) => surface.captures)) {
    const sourceImage = resolveInside(sourceDir, capture.image.path, 'Review source image');
    const outputImage = resolveInside(outputDir, capture.image.path, 'Review output image');
    mkdirSync(path.dirname(outputImage), { recursive: true });
    copyFileSync(sourceImage, outputImage);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const sourceArg = args.shift();
  if (!['build', 'serve', 'build-recipe'].includes(command) || !sourceArg) {
    throw new Error(usage());
  }

  if (command === 'build-recipe') {
    const recipePath = path.resolve(sourceArg);
    const artifactsDir = option(args, '--artifacts');
    const platform = option(args, '--platform');
    const sourceId = option(args, '--source-id');
    if (!artifactsDir || !platform || !sourceId) throw new Error(usage());
    const project = option(args, '--project');
    const title = option(args, '--title');
    const outputDir = path.resolve(
      option(args, '--output', path.join(artifactsDir, 'visual-review')),
    );
    if (args.length > 0) throw new Error(`Unknown options: ${args.join(' ')}`);
    buildRecipeReviewBoard({
      artifactsDir: path.resolve(artifactsDir),
      outputDir,
      platform,
      recipePath,
      sourceId,
      ...(project ? { project } : {}),
      ...(title ? { title } : {}),
    });
    console.log(path.join(outputDir, 'index.html'));
    return;
  }

  const sourcePath = path.resolve(sourceArg);
  const surfaceIds = options(args, '--surface');
  const outputDir = path.resolve(option(args, '--output', path.dirname(sourcePath)));
  const host = option(args, '--host', '127.0.0.1');
  const portValue = option(args, '--port', '0');
  if (args.length > 0) throw new Error(`Unknown options: ${args.join(' ')}`);
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }

  const source = selectSourceSurfaces(JSON.parse(readFileSync(sourcePath, 'utf8')), surfaceIds);
  copySourceImages(source, path.dirname(sourcePath), outputDir);
  generateReviewBoard({
    outputDir,
    source,
    storageKey: `farmslot-visual-review:${source.id}`,
  });

  if (command === 'build') {
    console.log(path.join(outputDir, 'index.html'));
  } else {
    const server = await serveReviewBoard({ directory: outputDir, host, port });
    console.log(server.url);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
