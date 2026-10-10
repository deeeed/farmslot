import path from 'node:path';

import {
  digestRecipeDocument,
  type RecipeConformanceCheck,
  type RecipeConformanceIdentity,
  type RecipeConformanceReport,
  type RecipeConformanceSource,
} from '@farmslot/protocol';
import { loadRecipeLibraries, type RecipeLibrarySource } from '@farmslot/recipe-runner';

import { libraryName } from './adapter-plugins.js';
import { writeContainedArtifact } from './artifact-files.js';
import type { RecipeCatalog } from './catalog.js';
import type { HarnessContext } from './context-state.js';
import {
  fileFingerprint,
  inputSourceSnapshot,
  providerSourceSnapshot,
  sourceIsDirty,
  sourceSnapshot,
} from './execution-provenance.js';
import { type CliOptions, optionString } from './parse-args.js';
import { recipeOutputRoots } from './paths.js';
import { resolveLibrarySources, resolveRunRecipeArg } from './recipe-library.js';
import { validateRunRecipeStatic } from './recipe-validation.js';
import type { ConsoleAllowlist } from './run-diagnostics.js';
import {
  activateRecipeRuntimeEnvironment,
  preflightRecipe,
  type RecipeEngine,
} from './run-engine.js';
import { recipeRunOptionsFromCli, recipeTrustOptionsFromCli } from './run-options.js';

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
  implementationSources?: Array<{ name: string; root: string; module?: string }>;
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
export async function recipeConformanceIdentity(
  catalog: RecipeCatalog,
  options: RecipeConformanceOptions,
): Promise<RecipeConformanceIdentity> {
  return resolvedConformanceIdentity(options, await resolveConformanceInputs(catalog, options));
}

type ResolvedConformanceInvocation = RecipeConformanceOptions['recipes'][number] & {
  recipeFile?: string;
  librarySources: RecipeLibrarySource[];
};

interface ConformanceInputs {
  invocations: ResolvedConformanceInvocation[];
  librarySources: RecipeLibrarySource[];
  configurationPaths: string[];
}

async function resolveConformanceInputs(
  catalog: RecipeCatalog,
  options: RecipeConformanceOptions,
): Promise<ConformanceInputs> {
  const adapter = options.context.adapter?.value;
  if (!adapter) throw new Error('Conformance requires a resolved adapter.');
  const invocations = await Promise.all(
    options.recipes.map(async (invocation) => {
      const resolved = await resolveRunRecipeArg(
        catalog,
        invocation.recipe,
        adapter,
        options.librarySources,
      );
      const recipeFile = 'recipeFile' in resolved ? resolved.recipeFile : undefined;
      const librarySources =
        recipeFile && !('ref' in resolved)
          ? await resolveLibrarySources(catalog, undefined, recipeFile, options.librarySources)
          : options.librarySources;
      return { ...invocation, recipeFile, librarySources };
    }),
  );
  const librarySources = new Map<string, RecipeLibrarySource>();
  for (const source of [
    ...options.librarySources,
    ...invocations.flatMap((invocation) => invocation.librarySources),
  ]) {
    librarySources.set(JSON.stringify([source.name, path.resolve(source.root)]), source);
  }
  return {
    invocations,
    librarySources: [...librarySources.values()],
    configurationPaths: [
      ...new Set(
        [
          ...options.configurationPaths,
          ...invocations.flatMap((invocation) =>
            invocation.recipeFile ? [invocation.recipeFile] : [],
          ),
        ].map((file) => path.resolve(file)),
      ),
    ],
  };
}

function resolvedConformanceIdentity(
  options: RecipeConformanceOptions,
  inputs: ConformanceInputs,
): RecipeConformanceIdentity {
  const adapter = options.context.adapter?.value;
  if (!adapter) throw new Error('Conformance requires a resolved adapter.');
  const excludedRoots = [
    options.artifactsDir,
    ...(options.context.project
      ? recipeOutputRoots(options.context.target.value, options.context.project)
      : []),
  ];
  const checkout = sourceSnapshot(
    options.context.project?.checkoutRoot ?? options.context.target.value,
    undefined,
    excludedRoots,
  );
  const provider = options.context.project
    ? providerSourceSnapshot(
        options.providerRoot,
        options.context.project.provider.module,
        excludedRoots,
      )
    : inputSourceSnapshot(options.providerRoot, excludedRoots);
  return {
    project: options.project,
    app: options.app ?? null,
    domain: options.domain ?? null,
    adapter,
    target: options.context.target.value,
    trustDigest: digestRecipeDocument(recipeTrustOptionsFromCli(options.cli ?? {})),
    selection: {
      slot: options.context.slot?.value ?? null,
      adapterTarget: options.context.adapter?.requested ?? options.context.adapter?.value ?? null,
      poolSlot: options.context.slot?.value
        ? (options.context.slot.poolSlot ??
          (options.context.slot.source === 'slot' ? options.context.slot.value : null))
        : null,
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
      ...withDirtyDigest(
        source.module
          ? providerSourceSnapshot(source.root, source.module, excludedRoots)
          : inputSourceSnapshot(source.root, excludedRoots),
      ),
    })),
    libraries: inputs.librarySources.map((source) => ({
      name: libraryName(source),
      path: path.resolve(source.root),
      ...withDirtyDigest(inputSourceSnapshot(source.root, excludedRoots)),
    })),
    invocations: inputs.invocations.map((invocation) => ({
      recipe: invocation.recipe,
      paramsDigest: digestRecipeDocument(invocation.params ?? {}),
    })),
    configuration: inputs.configurationPaths.map((file) => ({
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
  const inputs = await resolveConformanceInputs(engine, options);
  const identity = resolvedConformanceIdentity(options, inputs);
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
    artifactsDir: options.artifactsDir,
    target: identity.target,
    adapter: identity.adapter,
  };
  const runtimeOptions = recipeRunOptionsFromCli(identity.adapter, cli);
  const manifestPath = optionString(cli, 'actionManifest');
  const resolution: NonNullable<RecipeConformanceReport['resolution']> = {
    recipes: [],
    actions: [],
  };
  const restoreEnvironment = activateRecipeRuntimeEnvironment(
    identity.adapter,
    identity.target,
    runtimeOptions,
  );
  try {
    for (const invocation of inputs.invocations) {
      const id = `recipe.${invocation.recipe}`;
      try {
        const libraries = await loadRecipeLibraries(invocation.librarySources, {
          adapter: identity.adapter,
        });
        const manifest = await engine.resolveActionManifest(
          identity.adapter,
          manifestPath,
          invocation.librarySources,
        );
        resolution.recipes.push(
          ...[...libraries.recipes.values()]
            .filter((recipe) => !recipe.aliasFor)
            .map(({ ref, source, shadows }) => ({
              ref,
              source,
              shadows,
              invocation: invocation.recipe,
            })),
        );
        resolution.actions.push(
          ...[...manifest.actionSources].map(([action, source]) => ({
            action,
            source: source.name,
            invocation: invocation.recipe,
            ...(source.shadows ? { shadows: source.shadows } : {}),
          })),
        );
        const validated = await validateRunRecipeStatic(
          engine,
          invocation.recipe,
          identity.adapter,
          cli,
          invocation.params,
          invocation.librarySources,
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
          ...(error instanceof Error &&
          'userAction' in error &&
          typeof error.userAction === 'string'
            ? { userAction: error.userAction }
            : {}),
        });
      }
    }
  } finally {
    restoreEnvironment();
  }
  const current = await recipeConformanceIdentity(engine, options);
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
    resolution,
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
    dirtyDigest: sourceIsDirty(source) ? source.sourceFingerprint : null,
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
