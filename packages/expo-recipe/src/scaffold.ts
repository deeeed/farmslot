import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_HUD_PATH,
  BRIDGE_INDEX_PATH,
  BRIDGE_PROVIDER_PATH,
  DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
  DEFAULT_EXPO_RECIPE_PATH,
} from './constants.js';

export interface ExpoRecipeInstallOptions {
  projectRoot?: string;
  force?: boolean;
  withBridge?: boolean;
}

export interface ExpoRecipeInstallResult {
  projectRoot: string;
  written: string[];
  skipped: string[];
  packageJsonUpdated: boolean;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_ROOT = resolveTemplateRoot();

interface ScaffoldFile {
  source: string;
  target: string;
}

export async function installExpoRecipeScaffold(
  options: ExpoRecipeInstallOptions = {},
): Promise<ExpoRecipeInstallResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const files = scaffoldFiles(options.withBridge === true);
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const target = path.join(projectRoot, file.target);
    if (!options.force && existsSync(target)) {
      skipped.push(file.target);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(TEMPLATE_ROOT, file.source), target);
    written.push(file.target);
  }

  const packageJsonUpdated = await updatePackageScripts(projectRoot, options.force === true);
  return { projectRoot, written, skipped, packageJsonUpdated };
}

export function packageScripts(): Record<string, string> {
  return {
    recipe: 'farmslot-expo-recipe',
    'recipe:manifest': 'farmslot-expo-recipe manifest',
    'recipe:doctor': 'farmslot-expo-recipe doctor',
    'recipe:validate': 'farmslot-expo-recipe validate',
    'recipe:dry-run': 'farmslot-expo-recipe run --dry-run',
    'recipe:run': 'farmslot-expo-recipe run',
  };
}

function scaffoldFiles(withBridge: boolean): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { source: DEFAULT_EXPO_RECIPE_MANIFEST_PATH, target: DEFAULT_EXPO_RECIPE_MANIFEST_PATH },
    { source: DEFAULT_EXPO_RECIPE_PATH, target: DEFAULT_EXPO_RECIPE_PATH },
    { source: 'scripts/agentic/recipe/README.md', target: 'scripts/agentic/recipe/README.md' },
    { source: 'scripts/agentic/validate-recipe.sh', target: 'scripts/agentic/validate-recipe.sh' },
  ];
  if (!withBridge) return files;
  return [
    {
      source: 'scripts/agentic/recipe/action-manifest.with-bridge.json',
      target: DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
    },
    ...files.slice(1),
    { source: BRIDGE_PROVIDER_PATH, target: BRIDGE_PROVIDER_PATH },
    { source: BRIDGE_HUD_PATH, target: BRIDGE_HUD_PATH },
    { source: BRIDGE_INDEX_PATH, target: BRIDGE_INDEX_PATH },
  ];
}

async function updatePackageScripts(
  projectRoot: string,
  overwriteExisting = false,
): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return false;
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  packageJson.scripts = packageJson.scripts ?? {};
  let changed = false;
  for (const [name, command] of Object.entries(packageScripts())) {
    if (!overwriteExisting && Object.hasOwn(packageJson.scripts, name)) continue;
    if (packageJson.scripts[name] === command) continue;
    packageJson.scripts[name] = command;
    changed = true;
  }
  if (!changed) return false;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  return true;
}

function resolveTemplateRoot(): string {
  const packageRootCandidate = path.join(PACKAGE_ROOT, 'templates');
  if (existsSync(packageRootCandidate)) return packageRootCandidate;
  return path.resolve(process.cwd(), 'packages/expo-recipe/templates');
}
