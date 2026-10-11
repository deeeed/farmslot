import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Command } from 'commander';

import type { RecipeConformanceReport } from '@farmslot/protocol';
import { resolveSlotPoolDir } from '@farmslot/protocol/node/slot-by-repo';
import type {
  CliOptions,
  HarnessContext,
  RecipeConformanceOptions,
} from '@farmslot/recipe-cli/harness';
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
    .option('--runtime-dir <path>', 'Target-relative recipe runtime directory')
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
      const conformanceOptions = Object.keys(cmd.opts()).some(
        (name) => cmd.getOptionValueSource(name) === 'cli',
      );
      if (checkout !== undefined || conformanceOptions) {
        const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
        const error = Object.assign(new Error('Project and recipe checks require --conformance.'), {
          code: 'CONFORMANCE_REQUIRED',
          userAction: 'rerun with --conformance; checkout defaults to the current directory',
        });
        if (isMachineMode(output)) output.writeJson(errorEnvelope('doctor', error));
        else output.failure(error);
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
  const selected = shared.optionStrings(options, 'recipe') ?? [];
  const suppliedParams = shared.optionStrings(options, 'param') ?? [];
  if (suppliedParams.length && !selected.length) {
    throw shared.usageError(
      '--param requires --recipe to select the invocation receiving those parameters.',
    );
  }
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
  const workspace = resolveWorkspace();
  const configuredPool = resolveSlotPoolDir();
  const slotPoolDir =
    configuredPool && configuredPool.source !== 'farmslot-node'
      ? configuredPool.dir
      : workspace
        ? path.join(workspace.farmslotDir, 'pool')
        : undefined;
  const registry =
    shared.optionString(options, 'projectsDir') ??
    path.join(workspace?.farmslotDir ?? process.env.FARMSLOT_ROOT ?? repoRoot, 'projects');
  return shared.withProjectRecipeHost(
    {
      tokens,
      projectsDir: existsSync(registry) ? registry : undefined,
      slotPoolDir,
      command: 'doctor',
      options,
      authorizedProviders: shared.optionStrings(options, 'authorizeProvider'),
    },
    async ({ context, provider, engine, librarySources: sources, cli }) => {
      const binding = context.project!;
      const recipes = selected.length
        ? selected
        : [
            ...(
              await loadRecipeLibraries(sources, { adapter: provider.runtime.id })
            ).recipes.values(),
          ]
            .filter((entry) => !entry.aliasFor)
            .map((entry) => entry.ref);
      const params = parseRecipeParamAssignments(suppliedParams);
      const artifactsDir = path.join(binding.checkoutRoot, binding.artifactDir, 'conformance');
      const implementationSources: NonNullable<RecipeConformanceOptions['implementationSources']> =
        [];
      const addDependencies = (packagePath: string, prefix: string): void => {
        const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        const owner = createRequire(packagePath);
        for (const name of Object.keys(metadata.dependencies ?? {})
          .filter((name) => name.startsWith('@farmslot/'))
          .sort()) {
          addImplementation(name, owner, prefix);
        }
      };
      const addImplementation = (name: string, resolve: NodeRequire, prefix = ''): void => {
        let entry: string;
        try {
          entry = resolve.resolve(name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')
            throw error;
          // Some SDKs expose only subpaths, plus package.json for metadata discovery.
          entry = resolve.resolve(`${name}/package.json`);
        }
        const root = shared.recipePackageRoot(entry);
        const module = path.extname(entry) === '.json' ? undefined : entry;
        if (
          implementationSources.some((source) => source.root === root && source.module === module)
        )
          return;
        implementationSources.push({
          name: `${prefix}${name}`,
          root,
          ...(module ? { module } : {}),
        });
        addDependencies(path.join(root, 'package.json'), prefix);
      };
      addImplementation('@farmslot/recipe-cli', createRequire(import.meta.url));
      const providerPackage = path.join(binding.provider.root, 'package.json');
      if (existsSync(providerPackage)) addDependencies(providerPackage, 'provider:');
      const runtimeConfig = context.runtimeConfigPath;
      const report = await shared.checkRecipeConformance(engine, {
        project: binding.name,
        app: binding.app,
        domain: binding.domain,
        context,
        providerRoot: binding.provider.root,
        configurationPaths: [
          binding.configPath,
          ...(binding.manifest ? [binding.manifest] : []),
          ...(runtimeConfig ? [runtimeConfig] : []),
          ...(context.slot?.value && context.slot.poolFile ? [context.slot.poolFile] : []),
        ],
        librarySources: sources,
        implementationSources,
        artifactsDir,
        cli,
        recipes: recipes.map((recipe) => ({ recipe, params })),
      });
      const reportPath = await shared.writeRecipeConformanceReport(artifactsDir, report);
      return { context, report, reportPath };
    },
  );
}

async function renderProjectConformance(checkout: string | undefined, cmd: Command): Promise<void> {
  const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
  try {
    const result = await runProjectConformance(checkout, cmd.opts());
    const passed = result.report.status === 'pass';
    if (isMachineMode(output)) {
      output.writeJson({ ...okEnvelope('doctor', result), exitCode: passed ? 0 : 1 });
    } else {
      for (const check of result.report.checks) {
        output.write(
          `${check.status === 'pass' ? green('[OK]') : red('[FAIL]')} ${check.id}: ${check.message}\n`,
        );
        if (check.userAction) output.write(`  ${check.userAction}\n`);
      }
      output.write(`Report: ${result.reportPath}\n`);
    }
    if (!passed) process.exitCode = 1;
  } catch (err) {
    if (isMachineMode(output)) output.writeJson(errorEnvelope('doctor', err));
    else output.failure(err);
    process.exitCode = 1;
  }
}
