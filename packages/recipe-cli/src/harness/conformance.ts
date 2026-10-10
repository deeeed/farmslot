import path from 'node:path';

import type {
  RecipeConformanceCheck,
  RecipeConformanceIdentity,
  RecipeConformanceReport,
  RecipeConformanceSource,
} from '@farmslot/protocol';
import { loadRecipeLibraries, type RecipeLibrarySource } from '@farmslot/recipe-runner';

import { writeContainedArtifact } from './artifact-files.js';
import type { HarnessContext } from './context-state.js';
import { fileFingerprint, providerSourceSnapshot, sourceSnapshot } from './execution-provenance.js';
import { type CliOptions, optionString } from './parse-args.js';
import { recipeOutputRoots } from './paths.js';
import { validateRunRecipeStatic } from './recipe-validation.js';
import type { ConsoleAllowlist } from './run-diagnostics.js';
import {
  activateRecipeRuntimeEnvironment,
  preflightRecipe,
  type RecipeEngine,
} from './run-engine.js';
import { recipeRunOptionsFromCli } from './run-options.js';

export interface RecipeConformanceOptions {
  project: string;
  app?: string;
  domain?: string;
  context: HarnessContext;
  providerRoot: string;
  configurationPaths: string[];
  librarySources: RecipeLibrarySource[];
  artifactsDir: string;
  cli?: CliOptions;
  implementationSources?: Array<{ name: string; root: string }>;
  recipes: Array<{ recipe: string; params?: Record<string, unknown> }>;
}

export function conformanceChecksPass(checks: readonly RecipeConformanceCheck[]): boolean {
  const required = checks.filter((check) => check.required);
  return (
    required.length > 0 &&
    required.every((check) => check.status === 'pass' && check.evidence?.plan !== undefined)
  );
}

/** Bind static and live claims to the same code, configuration and target identities. */
export function recipeConformanceIdentity(
  options: RecipeConformanceOptions,
): RecipeConformanceIdentity {
  const adapter = options.context.adapter?.value;
  if (!adapter) throw new Error('Conformance requires a resolved adapter.');
  const excludedRoots = [
    options.artifactsDir,
    ...(options.context.project
      ? recipeOutputRoots(
          options.context.target.value,
          options.context.project.runtimeDir,
          options.context.project.artifactDir,
        )
      : []),
  ];
  const checkout = sourceSnapshot(
    options.context.project?.checkoutRoot ?? options.context.target.value,
    adapter,
    excludedRoots,
  );
  const provider = options.context.project
    ? providerSourceSnapshot(
        options.providerRoot,
        options.context.project.provider.module,
        excludedRoots,
      )
    : sourceSnapshot(options.providerRoot, undefined, excludedRoots);
  return {
    project: options.project,
    app: options.app ?? null,
    domain: options.domain ?? null,
    adapter,
    target: options.context.target.value,
    selection: {
      slot: options.context.slot?.value ?? null,
      device: typeof options.cli?.device === 'string' ? options.cli.device : null,
      ports: {
        ...(options.context.slot?.value ? options.context.slot.ports : {}),
        ...Object.fromEntries(
          Object.entries(options.context.ports ?? {}).flatMap(([name, port]) =>
            port.value === undefined ? [] : [[name, port.value]],
          ),
        ),
      },
      provider: options.context.project?.provider.module ?? null,
      manifest: options.context.project?.manifest ?? null,
    },
    checkout: withDirtyDigest(checkout),
    provider: withDirtyDigest(provider),
    implementation: options.implementationSources?.map((source) => ({
      name: source.name,
      ...withDirtyDigest(sourceSnapshot(source.root, undefined, excludedRoots)),
    })),
    libraries: options.librarySources.map((source) => ({
      name: source.name ?? path.basename(source.root),
      ...withDirtyDigest(sourceSnapshot(source.root, undefined, excludedRoots)),
    })),
    configuration: options.configurationPaths.map((file) => ({
      path: path.resolve(file),
      sourceFingerprint: fileFingerprint(file),
    })),
  };
}

export function assertConformanceReportCurrent(
  report: RecipeConformanceReport,
  identity: RecipeConformanceIdentity,
): void {
  if (report.schemaVersion !== 1 || !sameConformanceIdentity(report.identity, identity)) {
    throw new Error('Conformance report is stale; rerun farmslot doctor --conformance.');
  }
  if (report.status !== 'pass' || !conformanceChecksPass(report.checks)) {
    throw new Error('Conformance report has no passing evidence for every required check.');
  }
}

/** Inspect declared invocations through the execution preflight without launching or executing. */
export async function checkRecipeConformance<TMutation, TAllowlist extends ConsoleAllowlist>(
  engine: RecipeEngine<TMutation, TAllowlist>,
  options: RecipeConformanceOptions,
): Promise<RecipeConformanceReport> {
  const identity = recipeConformanceIdentity(options);
  const checks: RecipeConformanceCheck[] = [];
  if (options.recipes.length === 0) {
    checks.push({
      id: 'recipe.invocations',
      status: 'missing',
      required: true,
      message: 'Declare at least one recipe invocation to check.',
    });
  }
  const cli: CliOptions = {
    ...options.cli,
    library: options.librarySources.map((source) =>
      source.name ? `${source.name}=${source.root}` : source.root,
    ),
    artifactsDir: options.artifactsDir,
    target: identity.target,
    adapter: identity.adapter,
  };
  const runtimeOptions = recipeRunOptionsFromCli(identity.adapter, cli);
  const manifestPath = optionString(cli, 'actionManifest');
  const libraries = await loadRecipeLibraries(options.librarySources, {
    adapter: identity.adapter,
  });
  const manifest = await engine.resolveActionManifest(
    identity.adapter,
    manifestPath,
    options.librarySources,
  );
  const restoreEnvironment = activateRecipeRuntimeEnvironment(
    identity.adapter,
    identity.target,
    runtimeOptions,
  );
  try {
    for (const invocation of options.recipes) {
      const id = `recipe.${invocation.recipe}`;
      try {
        const validated = await validateRunRecipeStatic(
          engine,
          invocation.recipe,
          identity.adapter,
          cli,
          invocation.params,
        );
        if (validated.usageError || validated.errorCount > 0) {
          checks.push({
            id,
            status: 'fail',
            required: true,
            message:
              validated.usageError?.message ??
              validated.findings.map((finding) => finding.message).join('; '),
          });
          continue;
        }
        const execution = await preflightRecipe(
          engine,
          identity.adapter,
          validated.recipeFile,
          options.artifactsDir,
          identity.target,
          manifestPath,
          {
            ...runtimeOptions,
            readOnly: true,
            cli,
            params: validated.effectiveParams,
            librarySources: validated.librarySources,
            stdoutIsMachineContract: true,
          },
        );
        checks.push({
          id,
          status: 'pass',
          required: true,
          message: 'Dependency, parameter, handler and authorization preflight passed.',
          ...(execution.plan ? { evidence: { plan: execution.plan } } : {}),
        });
      } catch (error) {
        checks.push({
          id,
          status: 'fail',
          required: true,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    restoreEnvironment();
  }
  const current = recipeConformanceIdentity(options);
  if (!sameConformanceIdentity(identity, current)) {
    checks.push({
      id: 'inputs.stable',
      status: 'fail',
      required: true,
      message: 'Code or configuration changed while checking.',
    });
  }
  const passed = conformanceChecksPass(checks);
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    identity,
    status: passed ? 'pass' : 'fail',
    mode: 'static',
    checks,
    capabilities: [{ name: 'recipe.preflight', status: passed ? 'verified' : 'failed' }],
    resolution: {
      recipes: [...libraries.recipes.values()]
        .filter((recipe) => !recipe.aliasFor)
        .map(({ ref, source, shadows }) => ({ ref, source, shadows })),
      actions: [...manifest.actionSources].map(([action, source]) => ({
        action,
        source: source.name,
        ...(source.shadows ? { shadows: source.shadows } : {}),
      })),
    },
  };
}

function sameConformanceIdentity(
  left: RecipeConformanceIdentity,
  right: RecipeConformanceIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withDirtyDigest(source: RecipeConformanceSource): RecipeConformanceSource {
  return {
    ...source,
    dirtyDigest: source.status.trim() ? source.sourceFingerprint : null,
  };
}

export async function writeRecipeConformanceReport(
  artifactsDir: string,
  report: RecipeConformanceReport,
): Promise<string> {
  const relative = 'conformance-report.json';
  await writeContainedArtifact(
    artifactsDir,
    relative,
    `${JSON.stringify(report, null, 2)}\n`,
    'Conformance report',
  );
  return path.join(artifactsDir, relative);
}
