#!/usr/bin/env node

import { readFileSync } from 'node:fs';
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

function usage() {
  return [
    'Usage:',
    '  farmslot-visual-review <build|serve> <visual-review-source.json> [--output <dir>] [--host <host>] [--port <port>]',
    '  farmslot-visual-review build-recipe <recipe.json> --artifacts <dir> --platform <name> --source-id <project:catalog> [--project <id>] [--title <title>] [--output <dir>]',
  ].join('\n');
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
  const outputDir = path.resolve(option(args, '--output', path.dirname(sourcePath)));
  const host = option(args, '--host', '127.0.0.1');
  const portValue = option(args, '--port', '0');
  if (args.length > 0) throw new Error(`Unknown options: ${args.join(' ')}`);
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }

  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
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
