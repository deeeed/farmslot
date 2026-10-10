import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Command } from 'commander';

import type { RecipeConformanceReport } from '@farmslot/protocol';
import type { CliOptions, HarnessContext } from '@farmslot/recipe-cli/harness';
import { loadRecipeLibraries } from '@farmslot/recipe-runner';
import { parseRecipeParamAssignments } from '@farmslot/recipe-runner/cli/support';

import { bold, dim, green, red, yellow } from '../colors.js';
import { errorEnvelope, isMachineMode, okEnvelope } from '../envelope.js';
import { runDoctor } from '../onboarding/doctor.js';
import { maybePromptGithubStar, starSupportHint } from '../onboarding/star-prompt.js';
import { repoRoot, resolveWorkspace } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check installation or a checkout project and recipe conformance')
    .argument('[checkout]', 'Checkout to inspect')
    .option('--conformance', 'Check provider, libraries, handlers and full recipe preflight')
    .option('--project <name>', 'Select a registered project')
    .option('--projects-dir <path>', 'Operator-owned project registry')
    .option(
      '--authorize-provider <module>',
      'Authorize an exact discovered provider source',
      collect,
      [],
    )
    .option('--adapter <name>', 'Select the project runtime')
    .option('--app <name>', 'Select a monorepo app')
    .option('--slot <id>', 'Select one pool slot')
    .option('--device <id>', 'Select one device')
    .option('--cdp-port <port>', 'Select the CDP transport port')
    .option('--runtime-dir <path>', 'Checkout-relative runtime directory')
    .option('--artifacts-dir <path>', 'Checkout-relative report directory')
    .option('--library <name=path>', 'Override a recipe library', collect, [])
    .option(
      '--recipe <ref>',
      'Check a specific invocation instead of every catalog recipe',
      collect,
      [],
    )
    .option('--param <key=value>', 'Supply checked invocation parameters', collect, [])
    .option('--source-trust <trust>', 'Explicit recipe source trust')
    .option('--source-kind <kind>', 'Explicit recipe source kind')
    .action(async (checkout: string | undefined, _: unknown, cmd: Command) => {
      if (cmd.opts().conformance) {
        await renderProjectConformance(checkout, cmd);
        return;
      }
      if (checkout !== undefined) {
        const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
        const error = Object.assign(new Error('A checkout requires --conformance.'), {
          code: 'CONFORMANCE_REQUIRED',
          userAction: 'farmslot doctor <checkout> --conformance',
        });
        output.writeJson(errorEnvelope('doctor', error));
        process.exitCode = 1;
        return;
      }
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      let report;
      try {
        report = await runDoctor(resolveWorkspace());
      } catch (err) {
        if (isMachineMode(output)) {
          const envelope = errorEnvelope('doctor', err);
          output.writeJson(envelope);
          process.exitCode = envelope.exitCode;
        } else {
          output.failure(err);
        }
        return;
      }
      if (isMachineMode(output)) {
        // Doctor "checks failed" is still a successful diagnosis — the envelope
        // stays ok with report data; the process exit code carries the verdict.
        const envelope = okEnvelope('doctor', report);
        output.writeJson(report.ok ? envelope : { ...envelope, exitCode: 1 });
      } else {
        for (const section of report.sections) {
          output.write(`${bold(section.title)}\n`);
          for (const check of section.checks) {
            const mark = !check.ok ? red('[FAIL]') : check.warn ? yellow('[WARN]') : green('[OK]');
            output.write(
              `  ${mark} ${check.name}${check.detail ? dim(`  ${check.detail}`) : ''}\n`,
            );
            if ((!check.ok || check.warn) && check.hint) {
              output.write(`         ${dim(`fix: ${check.hint}`)}\n`);
            }
          }
        }
        output.write(
          report.ok
            ? `\n${green('doctor: all checks passed')}\n`
            : `\n${red('doctor: checks failed')}\n`,
        );
      }
      if (!report.ok) process.exitCode = 1;
      if (!isMachineMode(output) && report.ok) {
        const prompted = await maybePromptGithubStar();
        if (!prompted) {
          const hint = starSupportHint();
          if (hint) output.write(`${dim(hint)}\n`);
        }
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export interface ProjectConformanceResult {
  context: HarnessContext;
  report: RecipeConformanceReport;
  reportPath: string;
}

/** Check through the same authorized provider and preflight used by execution. */
export async function runProjectConformance(
  checkout: string | undefined,
  options: CliOptions,
): Promise<ProjectConformanceResult> {
  const shared = await import('@farmslot/recipe-cli/harness');
  const tokens: string[] = [];
  if (checkout) tokens.push('--target', path.resolve(checkout));
  for (const [key, flag] of Object.entries({
    project: '--project',
    adapter: '--adapter',
    app: '--app',
    slot: '--slot',
    device: '--device',
    cdpPort: '--cdp-port',
    runtimeDir: '--runtime-dir',
    artifactsDir: '--artifacts-dir',
    library: '--library',
  })) {
    const value = options[key];
    for (const entry of Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
      tokens.push(flag, entry);
  }
  const registry =
    shared.optionString(options, 'projectsDir') ??
    path.join(resolveWorkspace()?.farmslotDir ?? process.env.FARMSLOT_ROOT ?? repoRoot, 'projects');
  const previousHost = shared.harnessHost();
  const previousContext = shared.harnessContext();
  const previousAdapters = shared.harnessAdapters();
  try {
    const context = await shared.resolveProjectContext({
      tokens,
      projectsDir: existsSync(registry) ? registry : undefined,
    });
    const binding = context.project!;
    const provider = await shared.loadProjectProvider(context, {
      command: 'doctor',
      options,
      authorizedProviders: shared.optionStrings(options, 'authorizeProvider'),
    });
    context.ports = shared.contextPorts(context, tokens, {
      '--cdp-port': true,
      '--watcher-port': true,
    }).ports;
    shared.setHarnessContext(context);
    const libraries = shared.authorizedProjectLibraries(context);
    if (libraries.length !== binding.libraries.length)
      throw new shared.ProjectBindingError(
        'LIBRARY_UNAUTHORIZED',
        'Discovered recipe libraries are not authorized executable sources.',
        'register the project or select each library with --library name=path',
      );
    const library = libraries[0] ?? {
      name: binding.name,
      root: binding.provider.root,
    };
    const engine =
      provider.engine ??
      shared.createDefaultRecipeEngine({
        runtime: provider.runtime,
        catalog: shared.createRuntimeRecipeCatalog({
          runtime: provider.runtime,
          bundledLibrary: {
            name: library.name,
            root: library.root,
            actionNamespace: binding.domain ?? library.name,
          },
        }),
        runtimeSource: {
          kind: 'custom-adapter',
          trust: 'trusted',
          name: binding.name,
          path: binding.provider.root,
          digest: binding.provider.identity.sourceFingerprint,
        },
        resolveRuntimeDigest: async () =>
          shared.providerSourceSnapshot(binding.provider.root, binding.provider.module, [
            path.join(context.target.value, binding.artifactDir),
            path.join(context.target.value, binding.runtimeDir),
          ]).sourceFingerprint,
      });
    const sources = await shared.resolveLibrarySources(
      engine,
      libraries.map((entry) => `${entry.name}=${entry.root}`),
    );
    const selected = shared.optionStrings(options, 'recipe') ?? [];
    const recipes = selected.length
      ? selected
      : [...(await loadRecipeLibraries(sources, { adapter: provider.runtime.id })).recipes.values()]
          .filter((entry) => !entry.aliasFor)
          .map((entry) => entry.ref);
    const params = parseRecipeParamAssignments(shared.optionStrings(options, 'param') ?? []);
    const artifactsDir = path.join(context.target.value, binding.artifactDir, 'conformance');
    const packages = [
      '@farmslot/recipe-cli',
      '@farmslot/recipe-runner',
      '@farmslot/adapter-sdk',
      '@farmslot/protocol',
    ];
    const implementationSources = packages.map((name) => ({
      name,
      root: path.resolve(path.dirname(createRequire(import.meta.url).resolve(name)), '..'),
    }));
    const providerPackage = path.join(binding.provider.root, 'package.json');
    if (existsSync(providerPackage)) {
      const metadata = JSON.parse(readFileSync(providerPackage, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const requireProvider = createRequire(providerPackage);
      for (const name of packages) {
        if (!metadata.dependencies?.[name]) continue;
        const root = path.resolve(path.dirname(requireProvider.resolve(name)), '..');
        if (!implementationSources.some((source) => source.root === root))
          implementationSources.push({ name: `provider:${name}`, root });
      }
    }
    const runtimeConfig =
      process.env.RECIPE_RUNTIME_CONTEXT ??
      path.join(binding.checkoutRoot, binding.runtimeDir, 'agentic-runtime.json');
    const report = await shared.checkRecipeConformance(engine, {
      project: binding.name,
      app: binding.app,
      domain: binding.domain,
      context,
      providerRoot: binding.provider.root,
      configurationPaths: [
        binding.configPath,
        ...(binding.manifest ? [binding.manifest] : []),
        ...(existsSync(runtimeConfig) ? [runtimeConfig] : []),
        ...(context.slot?.value && context.slot.poolFile ? [context.slot.poolFile] : []),
      ],
      librarySources: sources,
      implementationSources,
      artifactsDir,
      cli: { ...options, ...(binding.manifest ? { actionManifest: binding.manifest } : {}) },
      recipes: recipes.map((recipe) => ({ recipe, params })),
    });
    const reportPath = await shared.writeRecipeConformanceReport(artifactsDir, report);
    return { context, report, reportPath };
  } finally {
    shared.setHarnessContext(previousContext);
    shared.configureHarnessAdapters(previousAdapters);
    shared.configureHarnessHost(previousHost);
  }
}

async function renderProjectConformance(checkout: string | undefined, cmd: Command): Promise<void> {
  const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
  try {
    const result = await runProjectConformance(checkout, cmd.opts());
    const passed = result.report.status === 'pass';
    if (isMachineMode(output)) {
      output.writeJson({ ...okEnvelope('doctor', result), exitCode: passed ? 0 : 1 });
    } else {
      for (const check of result.report.checks)
        output.write(
          `${check.status === 'pass' ? green('[OK]') : red('[FAIL]')} ${check.id}: ${check.message}\n`,
        );
      output.write(`Report: ${result.reportPath}\n`);
    }
    if (!passed) process.exitCode = 1;
  } catch (err) {
    if (isMachineMode(output)) output.writeJson(errorEnvelope('doctor', err));
    else output.failure(err);
    process.exitCode = 1;
  }
}
