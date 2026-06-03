import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_EXPO_RECIPE_MANIFEST_PATH, DEFAULT_EXPO_RECIPE_PATH } from './constants.js';
import { printDoctorResult, runExpoRecipeDoctor } from './doctor.js';
import {
  type ExpoRecipeRunOptions,
  runExpoRecipeDocument,
  validateExpoRecipeDocument,
} from './runner.js';
import { installExpoRecipeScaffold } from './scaffold.js';

interface ParsedCliOptions extends ExpoRecipeRunOptions {
  force?: boolean;
  withBridge?: boolean;
}

export async function runExpoRecipeCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'init') {
    const result = await installExpoRecipeScaffold(parseOptions(rest));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'manifest') {
    const options = parseOptions(rest);
    const manifestPath = resolveProjectPath(
      options.projectRoot,
      options.manifestPath ?? DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
    );
    console.log(await readFile(manifestPath, 'utf-8'));
    return;
  }

  if (command === 'doctor') {
    const options = parseOptions(rest);
    const result = await runExpoRecipeDoctor(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printDoctorResult(result);
    if (result.status === 'fail') process.exit(1);
    return;
  }

  if (command === 'validate') {
    const { recipePath, options } = parseRecipeCommand(rest);
    const result = await validateExpoRecipeDocument(recipePath, options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printValidationResult(result);
    if (result.status === 'invalid') process.exit(1);
    return;
  }

  if (command === 'run') {
    const { recipePath, options } = parseRecipeCommand(rest);
    const result = await runExpoRecipeDocument(recipePath, options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printRunResult(result);
    if (result.status !== 'pass') process.exit(1);
    return;
  }

  throw new Error(`Unknown farmslot-expo-recipe command: ${command}`);
}

function parseRecipeCommand(args: string[]): { recipePath: string; options: ParsedCliOptions } {
  if (args[0] && !args[0].startsWith('-')) {
    return { recipePath: args[0], options: parseOptions(args.slice(1)) };
  }
  return { recipePath: DEFAULT_EXPO_RECIPE_PATH, options: parseOptions(args) };
}

function parseOptions(args: string[]): ParsedCliOptions {
  const options: ParsedCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--with-bridge') options.withBridge = true;
    else if (arg === '--project-root') options.projectRoot = requiredValue(args, (index += 1), arg);
    else if (arg.startsWith('--project-root='))
      options.projectRoot = arg.slice('--project-root='.length);
    else if (arg === '--manifest') options.manifestPath = requiredValue(args, (index += 1), arg);
    else if (arg.startsWith('--manifest=')) options.manifestPath = arg.slice('--manifest='.length);
    else if (arg === '--artifacts-dir')
      options.artifactsDir = requiredValue(args, (index += 1), arg);
    else if (arg.startsWith('--artifacts-dir='))
      options.artifactsDir = arg.slice('--artifacts-dir='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

function resolveProjectPath(projectRoot: string | undefined, relativePath: string): string {
  return path.resolve(projectRoot ?? process.cwd(), relativePath);
}

function printValidationResult(
  result: Awaited<ReturnType<typeof validateExpoRecipeDocument>>,
): void {
  console.log(
    `Recipe validation: ${result.status} (${result.summary.errors} errors, ${result.summary.warnings} warnings)`,
  );
  for (const finding of result.findings) {
    console.log(`- ${finding.severity} ${finding.code} ${finding.path}: ${finding.message}`);
  }
}

function printRunResult(result: Awaited<ReturnType<typeof runExpoRecipeDocument>>): void {
  console.log(`Recipe run: ${result.status}`);
  console.log(`Artifacts: ${result.artifactManifestPath}`);
}

function printUsage(): void {
  console.log(
    `Farmslot Expo Recipe\n\nUsage:\n  farmslot-expo-recipe init [--project-root <dir>] [--force] [--with-bridge]\n  farmslot-expo-recipe manifest [--project-root <dir>] [--manifest <path>]\n  farmslot-expo-recipe doctor [--project-root <dir>] [--manifest <path>] [--json]\n  farmslot-expo-recipe validate [recipe] [--project-root <dir>] [--manifest <path>] [--json]\n  farmslot-expo-recipe run [recipe] [--project-root <dir>] [--manifest <path>] [--artifacts-dir <dir>] [--dry-run] [--json]\n`,
  );
}
