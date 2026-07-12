import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getRecipeActionManifestActionNames,
  type RecipeActionManifestDocument,
  type RecipeValidationFinding,
} from '@farmslot/protocol';
import { validateRecipeCliInput } from '@farmslot/recipe-harness/cli/support';

import { NATIVE_UI_ACTIONS } from './agent-device-ui-transport.js';
import {
  BRIDGE_PROVIDER_PATH,
  DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
  DEFAULT_EXPO_RECIPE_PATH,
} from './constants.js';
import { readJsonFile } from './json.js';
import type { ExpoRecipeRunOptions } from './runner.js';
import { packageScripts } from './scaffold.js';

export interface ExpoRecipeDoctorFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface ExpoRecipeDoctorResult {
  status: 'pass' | 'fail';
  projectRoot: string;
  recipePath: string;
  manifestPath: string;
  findings: ExpoRecipeDoctorFinding[];
}

export async function runExpoRecipeDoctor(
  options: ExpoRecipeRunOptions = {},
): Promise<ExpoRecipeDoctorResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const recipePath = DEFAULT_EXPO_RECIPE_PATH;
  const manifestPath = options.manifestPath ?? DEFAULT_EXPO_RECIPE_MANIFEST_PATH;
  const findings: ExpoRecipeDoctorFinding[] = [];
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const manifestAbsolutePath = path.join(projectRoot, manifestPath);
  const recipeAbsolutePath = path.join(projectRoot, recipePath);
  const providerAbsolutePath = path.join(projectRoot, BRIDGE_PROVIDER_PATH);

  if (!existsSync(packageJsonPath)) {
    findings.push(
      errorFinding('missing_package_json', 'package.json is required.', 'package.json'),
    );
  } else {
    const packageJson = (await readJsonFile(packageJsonPath)) as {
      scripts?: Record<string, string>;
    };
    findings.push(...checkPackageScripts(packageJson.scripts ?? {}));
  }

  if (!existsSync(manifestAbsolutePath)) {
    findings.push(
      errorFinding('missing_manifest', 'Recipe action manifest is missing.', manifestPath),
    );
  }
  if (!existsSync(recipeAbsolutePath)) {
    findings.push(errorFinding('missing_recipe', 'Default recipe is missing.', recipePath));
  }

  if (existsSync(manifestAbsolutePath) && existsSync(recipeAbsolutePath)) {
    findings.push(...(await checkRecipeValidation(projectRoot, recipePath, manifestPath)));
    const manifest = (await readJsonFile(manifestAbsolutePath)) as RecipeActionManifestDocument;
    findings.push(...(await checkBridgeContract(manifest, providerAbsolutePath)));
  }

  const status = findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass';
  return { status, projectRoot, recipePath, manifestPath, findings };
}

export function printDoctorResult(result: ExpoRecipeDoctorResult): void {
  console.log(`Farmslot Expo Recipe doctor: ${result.status}`);
  console.log(`Recipe: ${result.recipePath}`);
  console.log(`Manifest: ${result.manifestPath}`);
  if (result.findings.length === 0) return;
  for (const finding of result.findings) {
    const pathLabel = finding.path ? ` ${finding.path}` : '';
    console.log(`- ${finding.severity} ${finding.code}${pathLabel}: ${finding.message}`);
  }
}

function checkPackageScripts(scripts: Record<string, string>): ExpoRecipeDoctorFinding[] {
  return Object.entries(packageScripts()).flatMap(([name, command]) => {
    if (scripts[name] === command) return [];
    return [
      errorFinding(
        'script_mismatch',
        `package.json script ${name} must be ${JSON.stringify(command)}.`,
        `package.json#scripts.${name}`,
      ),
    ];
  });
}

async function checkRecipeValidation(
  projectRoot: string,
  recipePath: string,
  manifestPath: string,
): Promise<ExpoRecipeDoctorFinding[]> {
  const result = await validateRecipeCliInput({
    recipePath,
    actionManifestPath: manifestPath,
    baseDir: projectRoot,
  });
  return result.findings.map((finding: RecipeValidationFinding) => ({
    severity: finding.severity,
    code: `recipe.${finding.code}`,
    path: finding.path,
    message: finding.message,
  }));
}

async function checkBridgeContract(
  manifest: RecipeActionManifestDocument,
  providerAbsolutePath: string,
): Promise<ExpoRecipeDoctorFinding[]> {
  const actions = getRecipeActionManifestActionNames(manifest);
  const bridgeActions = new Set(['app.status', 'app.hud', 'app.trace']);
  const nativeActions = new Set<string>(NATIVE_UI_ACTIONS);
  const declaresBridge = actions.some((action) => bridgeActions.has(action));
  const declaresNative = actions.some((action) => nativeActions.has(action));
  const providerExists = existsSync(providerAbsolutePath);
  const platform = process.env.PLATFORM;
  const device =
    process.env.IOS_SIMULATOR ??
    process.env.SIMULATOR ??
    process.env.ADB_SERIAL ??
    process.env.ANDROID_SERIAL ??
    process.env.ANDROID_DEVICE;
  const app = process.env.FARMSLOT_RECIPE_APP_ID;
  const nativeEnvironmentStarted = Boolean(platform || device || app);
  const findings: ExpoRecipeDoctorFinding[] = [];
  if (declaresNative && nativeEnvironmentStarted && !(platform && device && app)) {
    findings.push({
      severity: 'warning',
      code: 'native_provider_incomplete',
      message:
        'Native UI actions require PLATFORM, an assigned simulator/device, and FARMSLOT_RECIPE_APP_ID; incomplete configuration falls back to the Metro bridge.',
    });
  }
  if (declaresBridge && !providerExists) {
    findings.push(
      errorFinding(
        'bridge_missing_provider',
        'Manifest declares app/UI bridge actions but src/farmslot/RecipeBridgeProvider.tsx is missing. Run farmslot-expo-recipe init --with-bridge --force or remove bridge actions.',
        BRIDGE_PROVIDER_PATH,
      ),
    );
    return findings;
  }
  if (!providerExists) return findings;

  const providerSource = await readFile(providerAbsolutePath, 'utf-8');
  if (!declaresBridge) {
    findings.push({
      severity: 'warning',
      code: 'bridge_provider_unused',
      path: BRIDGE_PROVIDER_PATH,
      message: 'Bridge provider exists, but the manifest does not declare app/UI bridge actions.',
    });
  }
  if (!providerSource.includes('__DEV__')) {
    findings.push(
      errorFinding(
        'bridge_missing_dev_guard',
        'Bridge provider must be guarded by __DEV__.',
        BRIDGE_PROVIDER_PATH,
      ),
    );
  }
  if (!providerSource.includes('EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE')) {
    findings.push(
      errorFinding(
        'bridge_missing_env_guard',
        'Bridge provider must require EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1.',
        BRIDGE_PROVIDER_PATH,
      ),
    );
  }
  return findings;
}

function errorFinding(code: string, message: string, pathValue?: string): ExpoRecipeDoctorFinding {
  return { severity: 'error', code, message, path: pathValue };
}
