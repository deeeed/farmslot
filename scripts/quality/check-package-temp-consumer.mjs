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
  run('yarn', ['workspace', '@farmslot/recipe-harness', 'build']);
  run('yarn', ['workspace', '@farmslot/skills', 'build']);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-package-consumer-'));
  try {
    await mkdir(path.join(tempRoot, 'src'), { recursive: true });
    await linkWorkspacePackage(tempRoot, 'protocol', 'packages/protocol');
    await linkWorkspacePackage(tempRoot, 'recipe-harness', 'packages/recipe-harness');
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
  createRecipeRunner,
  createStandardCoreAdapters,
  createStandardUiAdapters,
  type ActionAdapter,
} from '@farmslot/recipe-harness';
import { runRecipeHarnessCli } from '@farmslot/recipe-harness/cli';
import { validateRecipeCliInput } from '@farmslot/recipe-harness/cli/support';
import { JsonArtifactWriter } from '@farmslot/recipe-harness/writers';
import { dataTestId } from '@farmslot/recipe-harness/runtime/cdp';
import { createReactNativeBridgeUiTransport } from '@farmslot/recipe-harness/runtime/react-native-bridge';
import { FARMSLOT_SKILL_NAMES } from '@farmslot/skills';

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
const adapters: ActionAdapter[] = createStandardCoreAdapters({ actions: ['wait'] });

void result;
void runMethod;
void maybeRun;
void adapters;
void createRecipeRunner;
void createStandardUiAdapters;
void COMMAND_CENTER_SURFACES;
void buildCommandCenterContext;
void runRecipeHarnessCli;
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
import { createStandardCoreAdapters } from '@farmslot/recipe-harness';
import { runRecipeHarnessCli } from '@farmslot/recipe-harness/cli';
import { dataTestId } from '@farmslot/recipe-harness/runtime/cdp';
import { FARMSLOT_SKILL_NAMES } from '@farmslot/skills';

if (validateRecipeDocument({}).status !== 'invalid') throw new Error('recipe validator smoke failed');
if (RunMethods.get !== 'run.get') throw new Error('run RPC smoke failed');
if (!COMMAND_CENTER_SURFACES.length) throw new Error('surface registry smoke failed');
if (!createStandardCoreAdapters({ actions: ['wait'] }).length) throw new Error('harness root smoke failed');
if (typeof runRecipeHarnessCli !== 'function') throw new Error('harness cli smoke failed');
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
