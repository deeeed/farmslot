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
  isRecord,
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

async function readRecipeResolutionBundle(artifactDir: string) {
  const recipeResolution = await readJson(path.join(artifactDir, 'recipe-resolution.json'));
  const resolvedRecipes: Record<string, unknown> = {};
  if (isRecord(recipeResolution) && Array.isArray(recipeResolution.dependencies)) {
    for (const dependency of recipeResolution.dependencies) {
      if (
        isRecord(dependency) &&
        typeof dependency.digest === 'string' &&
        typeof dependency.artifact === 'string'
      ) {
        resolvedRecipes[dependency.digest] = await readJson(
          path.join(artifactDir, dependency.artifact),
        );
      }
    }
  }
  return { recipeResolution, resolvedRecipes };
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
    const trace = await readJson(path.join(artifactDir, 'trace.json'));
    const resolution = await readRecipeResolutionBundle(artifactDir);
    const artifactPaths = await listRelativeFiles(artifactDir);
    const result = mergeRecipeValidationResults([
      validateRecipeWithManifest(recipe, actionManifest),
      validateRecipeArtifactPackage({ recipe, trace, manifest, artifactPaths, ...resolution }),
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
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Farmslot Recipe Protocol v1 local self-validation',
    description:
      'Executes the repo-local self-validation suite through the real recipe harness and validates the emitted Recipe v1 artifact package.',
    workflow: {
      entry: 'validate-fixtures',
      nodes: {
        'validate-fixtures': {
          action: 'command',
          cmd: `yarn exec tsx scripts/e2e-recipe-protocol-self-validation.mts --fixture-check --report ${shellQuote(reportRel)} --log ${shellQuote(logRel)}`,
          timeout_ms: 120_000,
          next: 'index-artifacts',
          intent:
            'Produce a machine-readable report for every checked-in Recipe v1 fixture package',
        },
        'index-artifacts': {
          action: 'index_artifacts',
          artifacts: [
            {
              path: reportRel,
              type: 'report',
              label: 'Self-validation fixture contract report',
            },
            {
              path: logRel,
              type: 'log',
              label: 'Self-validation fixture contract log',
            },
          ],
          next: 'done',
          intent: 'Keep the validation report and log together for reviewer inspection',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

async function runSelfValidation(args: ParsedArgs): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const defaultRunRoot = path.join(repoRoot, 'temp/recipe-protocol-self-validation', runId);
  const runRoot = path.resolve(args.artifactsDir ?? defaultRunRoot);
  const sourceRoot = path.join(runRoot, 'source');
  const artifactsDir = path.join(runRoot, 'artifacts');
  if (args.artifactsDir) {
    const existingEntries = await readdir(runRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existingEntries && existingEntries.length > 0) {
      throw new Error(`--artifacts-dir must be empty or absent: ${runRoot}`);
    }
  } else {
    await rm(runRoot, { recursive: true, force: true });
  }
  await mkdir(sourceRoot, { recursive: true });

  const reportRel = path.relative(
    repoRoot,
    path.join(sourceRoot, 'reports/contract-validation.json'),
  );
  const logRel = path.relative(repoRoot, path.join(sourceRoot, 'logs/onboarding-validation.log'));
  const recipeDocument = buildRuntimeRecipe(reportRel, logRel);
  const actionManifest = await readJson(actionManifestPath);
  const runtimeActions = ['command', 'index_artifacts', 'end'];
  const manifestActions =
    ((actionManifest as Record<string, unknown>).actions as Record<string, unknown>) ?? {};
  const runtimeManifest = {
    $schema: (actionManifest as Record<string, unknown>).$schema,
    actions: Object.fromEntries(runtimeActions.map((action) => [action, manifestActions[action]])),
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

  const result = await runner.run({
    recipeDocument,
    artifactsDir,
    projectRoot: repoRoot,
    source: {
      kind: 'operator',
      trust: 'trusted',
      name: 'Farmslot Recipe Protocol self-validation',
    },
  });
  const manifest = await readJson(path.join(artifactsDir, 'artifact-manifest.json'));
  const trace = await readJson(path.join(artifactsDir, 'trace.json'));
  const resolution = await readRecipeResolutionBundle(artifactsDir);
  const artifactPaths = await listRelativeFiles(artifactsDir);
  const validation = validateRecipeArtifactPackage({
    recipe: recipeDocument,
    trace,
    manifest,
    artifactPaths,
    ...resolution,
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
