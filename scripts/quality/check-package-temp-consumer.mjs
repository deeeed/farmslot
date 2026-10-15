#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });
}

async function linkWorkspacePackage(tempRoot, packageName, packagePath) {
  const scopeDir = path.join(tempRoot, 'node_modules', '@farmslot');
  await mkdir(scopeDir, { recursive: true });
  await symlink(path.join(repoRoot, packagePath), path.join(scopeDir, packageName), 'dir');
}

async function main() {
  run('yarn', ['workspace', '@farmslot/recipe-runner', 'build']);
  run('yarn', ['workspace', '@farmslot/adapter-sdk', 'build']);
  run('yarn', ['workspace', '@farmslot/skills', 'build']);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-package-consumer-'));
  try {
    await mkdir(path.join(tempRoot, 'src'), { recursive: true });
    await linkWorkspacePackage(tempRoot, 'protocol', 'packages/protocol');
    await linkWorkspacePackage(tempRoot, 'recipe-runner', 'packages/recipe-runner');
    await linkWorkspacePackage(tempRoot, 'adapter-sdk', 'packages/adapter-sdk');
    await linkWorkspacePackage(tempRoot, 'skills', 'packages/skills');

    await writeFile(
      path.join(tempRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'farmslot-package-consumer-smoke',
          private: true,
          type: 'module',
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(tempRoot, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            types: ['node'],
            typeRoots: [path.join(repoRoot, 'node_modules/@types')],
            skipLibCheck: false,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(tempRoot, 'src', 'index.ts'),
      `import {
  RECIPE_PROTOCOL_SCHEMA_VERSION,
  validateRecipeDocument,
} from '@farmslot/protocol';
import type { Run } from '@farmslot/protocol/contracts/runs';
import { RunMethods } from '@farmslot/protocol/rpc/run';
import {
  buildCommandCenterContext,
  COMMAND_CENTER_SURFACES,
} from '@farmslot/protocol/surfaces/command-center';
import {
  captureHelperSnapshot,
  createRecipeRunner,
  createStandardCoreAdapters,
  createStandardUiAdapters,
  type ActionHandler,
} from '@farmslot/recipe-runner';
import { runRecipeRunnerCli } from '@farmslot/recipe-runner/cli';
import { validateRecipeCliInput } from '@farmslot/recipe-runner/cli/support';
import { JsonArtifactWriter } from '@farmslot/recipe-runner/writers';
import { dataTestId, type UiScreenshotCapture } from '@farmslot/recipe-runner/runtime/cdp';
import { createReactNativeBridgeUiTransport } from '@farmslot/recipe-runner/runtime/react-native-bridge';
import { FARMSLOT_SKILL_NAMES } from '@farmslot/skills';
import type { ProjectRuntime, ActionCatalog } from '@farmslot/adapter-sdk';
// @ts-expect-error The former runtime contract export is removed.
import type { PlatformAdapter } from '@farmslot/adapter-sdk';
// @ts-expect-error The former catalog contract export is removed.
import type { AdapterActions } from '@farmslot/adapter-sdk';
// @ts-expect-error The former handler contract export is removed.
import type { ActionAdapter } from '@farmslot/recipe-runner';
// @ts-expect-error The former handler constructor export is removed.
import { defineActionAdapter } from '@farmslot/recipe-runner';
export type RemovedContracts = [PlatformAdapter, AdapterActions, ActionAdapter, typeof defineActionAdapter];
const runtimeCatalogMatches: ProjectRuntime['actions'] extends ActionCatalog ? true : never = true;
void runtimeCatalogMatches;

const result = validateRecipeDocument({
  schema_version: RECIPE_PROTOCOL_SCHEMA_VERSION,
  title: 'Consumer smoke',
  description: 'Typechecks public package imports.',
  validate: {
    workflow: {
      entry: 'done',
      nodes: { done: { action: 'end', status: 'pass' } },
    },
  },
});

const runMethod: string = RunMethods.get;
const maybeRun: Run | undefined = undefined;
const adapters: ActionHandler[] = createStandardCoreAdapters({ actions: ['wait'] });
const screenshot: UiScreenshotCapture = { data: new Uint8Array([0]) };

void result;
void runMethod;
void maybeRun;
void adapters;
void screenshot;
void captureHelperSnapshot;
void createRecipeRunner;
void createStandardUiAdapters;
void COMMAND_CENTER_SURFACES;
void buildCommandCenterContext;
void runRecipeRunnerCli;
void validateRecipeCliInput;
void JsonArtifactWriter;
void dataTestId;
void createReactNativeBridgeUiTransport;
void FARMSLOT_SKILL_NAMES;
`,
    );
    await writeFile(
      path.join(tempRoot, 'runtime-smoke.mjs'),
      `import { validateRecipeDocument } from '@farmslot/protocol';
import { RunMethods } from '@farmslot/protocol/rpc/run';
import { COMMAND_CENTER_SURFACES } from '@farmslot/protocol/surfaces/command-center';
import * as recipeRunner from '@farmslot/recipe-runner';
import { createStandardCoreAdapters, defineActionHandler } from '@farmslot/recipe-runner';
import { runRecipeRunnerCli } from '@farmslot/recipe-runner/cli';
import { dataTestId } from '@farmslot/recipe-runner/runtime/cdp';
import { FARMSLOT_SKILL_NAMES } from '@farmslot/skills';

if (validateRecipeDocument({}).status !== 'invalid') throw new Error('recipe validator smoke failed');
if (RunMethods.get !== 'run.get') throw new Error('run RPC smoke failed');
if (!COMMAND_CENTER_SURFACES.length) throw new Error('surface registry smoke failed');
const handler = createStandardCoreAdapters({ actions: ['wait'] })[0];
if (!handler || defineActionHandler(handler) !== handler) throw new Error('handler constructor smoke failed');
if ('defineActionAdapter' in recipeRunner) throw new Error('retired constructor export remains');
if (typeof runRecipeRunnerCli !== 'function') throw new Error('harness cli smoke failed');
if (dataTestId('x') !== '[data-testid="x"]') throw new Error('harness cdp smoke failed');
if (!FARMSLOT_SKILL_NAMES.includes('recipe-cook')) throw new Error('skills import smoke failed');
`,
    );

    run(
      'node',
      [path.join(repoRoot, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'],
      {
        cwd: tempRoot,
      },
    );
    run('node', ['runtime-smoke.mjs'], { cwd: tempRoot });
    run(
      'node',
      [
        path.join(tempRoot, 'node_modules/@farmslot/skills/bin/farmslot-skills.mjs'),
        'install',
        '--target',
        tempRoot,
        '--layout',
        'agents',
        '--include',
        'recipe-cook',
      ],
      { cwd: tempRoot },
    );
    await access(path.join(tempRoot, '.agents/skills/recipe-cook/SKILL.md'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
console.log('Farmslot package temp-consumer smoke passed.');
