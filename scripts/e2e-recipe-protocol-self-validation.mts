#!/usr/bin/env tsx
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.ts';
import {
  getRecipeActionManifestActionNames,
  mergeRecipeValidationResults,
  validateRecipeArtifactPackage,
  validateRecipeWithManifest,
  type RecipeValidationFinding,
} from '../packages/protocol/src/recipe/index.ts';

interface SuiteEntry {
  id: string;
  recipe: string;
  artifactDir: string;
}

interface ParsedArgs {
  fixtureCheck: boolean;
  report?: string;
  log?: string;
  artifactsDir?: string;
  json: boolean;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suiteRoot = path.join(repoRoot, 'docs/examples/recipes/farmslot');
const suitePath = path.join(suiteRoot, 'self-validation-suite.json');
const actionManifestPath = path.join(
  repoRoot,
  'docs/examples/recipes/farmslot-v1.action-manifest.json',
);

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { fixtureCheck: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture-check') args.fixtureCheck = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--report') args.report = requiredValue(argv, (index += 1), arg);
    else if (arg.startsWith('--report=')) args.report = arg.slice('--report='.length);
    else if (arg === '--log') args.log = requiredValue(argv, (index += 1), arg);
    else if (arg.startsWith('--log=')) args.log = arg.slice('--log='.length);
    else if (arg === '--artifacts-dir') args.artifactsDir = requiredValue(argv, (index += 1), arg);
    else if (arg.startsWith('--artifacts-dir='))
      args.artifactsDir = arg.slice('--artifacts-dir='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

async function listRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath.split(path.sep).join('/'));
  }
  return files.sort();
}

function formatFinding(finding: RecipeValidationFinding): string {
  return `${finding.severity} ${finding.code} ${finding.path}: ${finding.message}`;
}

async function validateSelfValidationFixtures() {
  const suite = (await readJson(suitePath)) as { recipes?: SuiteEntry[] };
  if (!Array.isArray(suite.recipes))
    throw new Error('self-validation-suite.json recipes must be an array.');
  const actionManifest = await readJson(actionManifestPath);
  const entries = [];

  for (const entry of suite.recipes) {
    const recipePath = path.join(suiteRoot, entry.recipe);
    const artifactDir = path.join(suiteRoot, entry.artifactDir);
    const recipe = await readJson(recipePath);
    const manifest = await readJson(path.join(artifactDir, 'artifact-manifest.json'));
    const artifactPaths = await listRelativeFiles(artifactDir);
    const result = mergeRecipeValidationResults([
      validateRecipeWithManifest(recipe, actionManifest),
      validateRecipeArtifactPackage({ recipe, manifest, artifactPaths }),
    ]);
    entries.push({
      id: entry.id,
      recipe: path.relative(repoRoot, recipePath),
      artifactDir: path.relative(repoRoot, artifactDir),
      status: result.status,
      findings: result.findings,
      summary: result.summary,
    });
  }

  return {
    schemaVersion: 1,
    kind: 'recipe-protocol-self-validation-fixtures',
    status: entries.every((entry) => entry.status === 'valid') ? 'pass' : 'fail',
    checkedAt: new Date().toISOString(),
    entries,
  };
}

async function writeFixtureCheckArtifacts(args: ParsedArgs): Promise<void> {
  if (!args.report || !args.log) throw new Error('--fixture-check requires --report and --log.');
  const report = await validateSelfValidationFixtures();
  const lines = [
    `Recipe Protocol self-validation fixtures: ${report.status}`,
    ...report.entries.map(
      (entry) =>
        `- ${entry.id}: ${entry.status} (${entry.summary.errors} errors, ${entry.summary.warnings} warnings)`,
    ),
  ];
  for (const entry of report.entries) {
    for (const finding of entry.findings) lines.push(`  ${entry.id}: ${formatFinding(finding)}`);
  }

  await mkdir(path.dirname(path.resolve(repoRoot, args.report)), { recursive: true });
  await mkdir(path.dirname(path.resolve(repoRoot, args.log)), { recursive: true });
  await writeFile(path.resolve(repoRoot, args.report), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.resolve(repoRoot, args.log), `${lines.join('\n')}\n`);
  if (report.status !== 'pass') process.exit(1);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildRuntimeRecipe(reportRel: string, logRel: string) {
  return {
    schema_version: 1,
    title: 'Farmslot Recipe Protocol v1 local self-validation',
    description:
      'Executes the repo-local self-validation suite through the real recipe harness and validates the emitted Recipe v1 artifact package.',
    validate: {
      workflow: {
        entry: 'validate-fixtures',
        nodes: {
          'validate-fixtures': {
            action: 'command',
            cmd: `yarn exec tsx scripts/e2e-recipe-protocol-self-validation.mts --fixture-check --report ${shellQuote(reportRel)} --log ${shellQuote(logRel)}`,
            timeout_ms: 120_000,
            next: 'assert-report',
            intent:
              'Run the self-validation fixture contract checks and write machine-readable report artifacts.',
          },
          'assert-report': {
            action: 'assert_json',
            path: reportRel,
            assert: { path: '$.status', operator: 'eq', value: 'pass' },
            next: 'index-artifacts',
            intent:
              'Assert the fixture contract report passed before publishing it as recipe evidence.',
          },
          'index-artifacts': {
            action: 'index_artifacts',
            artifacts: [
              {
                path: reportRel,
                type: 'report',
                label: 'Self-validation fixture contract report',
                category: 'system',
              },
              {
                path: logRel,
                type: 'log',
                label: 'Self-validation fixture contract log',
                category: 'system',
              },
            ],
            next: 'done',
            intent: 'Publish the self-validation report and log into the typed artifact manifest.',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
}

async function runSelfValidation(args: ParsedArgs): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const runRoot = path.resolve(
    args.artifactsDir ?? path.join(repoRoot, 'temp/recipe-protocol-self-validation', runId),
  );
  const sourceRoot = path.join(runRoot, 'source');
  const artifactsDir = path.join(runRoot, 'artifacts');
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });

  const reportRel = path.relative(
    repoRoot,
    path.join(sourceRoot, 'reports/contract-validation.json'),
  );
  const logRel = path.relative(repoRoot, path.join(sourceRoot, 'logs/onboarding-validation.log'));
  const recipeDocument = buildRuntimeRecipe(reportRel, logRel);
  const actionManifest = await readJson(actionManifestPath);
  const runtimeActions = ['command', 'assert_json', 'index_artifacts', 'end'];
  const runtimeActionSet = new Set(runtimeActions);
  const runtimeManifest = {
    ...(actionManifest as Record<string, unknown>),
    supported_official_actions: runtimeActions,
    action_metadata: Object.fromEntries(
      Object.entries(
        ((actionManifest as Record<string, unknown>).action_metadata as Record<string, unknown>) ??
          {},
      ).filter(([action]) => runtimeActionSet.has(action)),
    ),
    native_bindings: (
      ((actionManifest as Record<string, unknown>).native_bindings as Record<string, unknown>[]) ??
      []
    ).filter(
      (binding) => typeof binding.action === 'string' && runtimeActionSet.has(binding.action),
    ),
    pre_conditions: [],
  };
  const runner = createRecipeRunner({
    actionManifest: runtimeManifest as never,
    adapters: createStandardCoreAdapters({
      actions: getRecipeActionManifestActionNames(runtimeManifest as never),
    }),
    runner: {
      source: 'farmslot-recipe-protocol-self-validation',
      git_ref: 'local',
      name: 'Farmslot Recipe Protocol self-validation',
    },
    logger: console,
  });

  const result = await runner.run({ recipeDocument, artifactsDir, projectRoot: repoRoot });
  const manifest = await readJson(path.join(artifactsDir, 'artifact-manifest.json'));
  const artifactPaths = await listRelativeFiles(artifactsDir);
  const validation = validateRecipeArtifactPackage({
    recipe: recipeDocument,
    manifest,
    artifactPaths,
  });
  const payload = {
    schemaVersion: 1,
    status: result.status === 'pass' && validation.status === 'valid' ? 'pass' : 'fail',
    runRoot,
    artifactsDir,
    result,
    validation,
  };

  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`Recipe Protocol self-validation: ${payload.status}`);
    console.log(`Artifacts: ${artifactsDir}`);
  }
  if (payload.status !== 'pass') process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.fixtureCheck) await writeFixtureCheckArtifacts(args);
else await runSelfValidation(args);
