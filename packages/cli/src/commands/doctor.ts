import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import type { Command } from 'commander';

import {
  type RecipeConformanceReport,
  validateRecipeActionManifestDocument,
} from '@farmslot/protocol';
import type {
  CliOptions,
  HarnessContext,
  JsonStreamWriter,
  RecipeConformanceOptions,
} from '@farmslot/recipe-cli/harness';
import { parseRecipeParamAssignments } from '@farmslot/recipe-runner/cli/support';

import { bold, dim, green, red, yellow } from '../colors.js';
import { createEmitter, errorEnvelope, isMachineMode, okEnvelope } from '../envelope.js';
import { runDoctor } from '../onboarding/doctor.js';
import { maybePromptGithubStar, starSupportHint } from '../onboarding/star-prompt.js';
import { resolveWorkspace } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

import { validateRecipeArtifactDirectory } from './recipe.js';
import { withLiveRecipeAuthority } from './recipe-live-authority.js';
import {
  collectRecipeOption,
  projectCommandInvocation,
  projectRecipeHostOptions,
  recipeProjectOptions,
} from './recipe-project.js';

export function registerDoctorCommand(program: Command): void {
  recipeProjectOptions(
    program
      .command('doctor')
      .description('Check installation or a checkout project and recipe conformance')
      .argument('[checkout]', 'Checkout to inspect'),
  )
    .option('--target <path>', 'Checkout to inspect; alternative to the checkout argument')
    .option('--fix', 'Repair declared project readiness problems')
    .option('--expect-live', 'Require the selected runtime to be ready')
    .option('--print-ready', 'Print the project health indicator when ready')
    .option('--all-devices', 'Include all discovered devices in readiness output')
    .option('--json-stream', 'Stream explicit repairs and their terminal result')
    .option('--action-manifest <path>', 'Select an action manifest')
    .option('--domain <name>', 'Select the recipe domain for conformance')
    .option('--conformance', 'Check provider, libraries, handlers and full recipe preflight')
    .option('--live', 'Execute one bounded smoke after conformance preflight')
    .option(
      '--check-report <path>',
      'Verify a saved report against current sources and retained proof',
    )
    .option('--disposable', 'Confirm this smoke target is disposable')
    .option('--smoke-target <id>', 'Declared runtime proof target to verify')
    .option('--teardown-target <id>', 'Declared proof target asserted in authored teardown')
    .option('--run <id>', 'Existing Gateway run that owns the selected pool target')
    .option('--live-timeout-ms <ms>', 'Live smoke execution deadline in milliseconds', '120000')
    .option('--approve-plan <digest>', 'Explicit approval of an execution plan')
    .option('--artifacts-dir <path>', 'Checkout-relative conformance report directory')
    .option('--report-name <name>', 'Conformance report filename within its artifact directory')
    .option(
      '--recipe <ref>',
      'Check a specific invocation instead of the declared defaults',
      collectRecipeOption,
      [],
    )
    .option('--param <key=value>', 'Supply checked invocation parameters', collectRecipeOption, [])
    .option('--source-trust <trust>', 'Explicit recipe source trust')
    .option('--source-kind <kind>', 'Explicit recipe source kind')
    .action(async (checkout: string | undefined, _: unknown, cmd: Command) => {
      const options = cmd.opts();
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const emitter = createEmitter(output, cmd);
      if (
        checkout !== undefined &&
        typeof options.target === 'string' &&
        path.resolve(checkout) !== path.resolve(options.target)
      ) {
        emitter.fail(
          new Error('The checkout argument and --target must select the same checkout.'),
        );
        return;
      }
      const conformanceOnly = [
        'domain',
        'artifactsDir',
        'reportName',
        'live',
        'checkReport',
        'disposable',
        'smokeTarget',
        'teardownTarget',
        'run',
        'liveTimeoutMs',
        'recipe',
        'param',
        'sourceTrust',
        'sourceKind',
        'approvePlan',
      ];
      const hasConformanceFlags = conformanceOnly.some(
        (name) => cmd.getOptionValueSource(name) === 'cli',
      );
      if (!options.conformance && hasConformanceFlags) {
        emitter.fail(
          Object.assign(new Error('Recipe checks require --conformance.'), {
            code: 'CONFORMANCE_REQUIRED',
            userAction: 'rerun with --conformance; checkout defaults to the current directory',
          }),
        );
        return;
      }
      if (options.conformance) {
        if (options.fix || options.expectLive || options.printReady || options.jsonStream) {
          emitter.fail(
            new Error('Readiness repair/probe flags cannot be combined with --conformance.'),
          );
          return;
        }
        await renderProjectConformance(checkout, cmd);
        return;
      }
      const projectOptions = Object.keys(options).some(
        (name) => cmd.getOptionValueSource(name) === 'cli',
      );
      if (checkout !== undefined || projectOptions) {
        await renderProjectReadiness(checkout, cmd);
        return;
      }
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

async function renderProjectReadiness(checkout: string | undefined, cmd: Command): Promise<void> {
  const globals = cmd.optsWithGlobals();
  const output = new OutputContext(Boolean(globals.json));
  const emit = createEmitter(output, cmd);
  const options: CliOptions = {
    ...globals,
    json: globals.printReady ? Boolean(globals.json) : isMachineMode(output),
  };
  let stream: JsonStreamWriter | undefined;
  let releaseResult = () => {};
  let restoreStdout = () => {};
  try {
    const shared = await import('@farmslot/recipe-cli/harness');
    if (options.jsonStream === true) {
      stream = new shared.JsonStreamWriter('doctor', true);
      releaseResult = stream.deferResult();
      restoreStdout = stream.isolateStdout();
      if (options.fix !== true) throw shared.usageError('--json-stream requires --fix.');
    }
    const invocation = projectCommandInvocation(cmd, { positionals: [{ label: 'checkout' }] });
    process.exitCode = await shared.withProjectRecipeHost(
      {
        ...(await projectRecipeHostOptions('doctor', checkout, options)),
        invocation,
      },
      async ({ context, provider, engine, librarySources, invocation: parsed, finalize }) => {
        if (!parsed) throw new Error('Project readiness invocation was not validated.');
        const providerOptions = provider.commandOptions?.doctor;
        const execute = async () => {
          const code = await shared.handleDoctor(parsed, {
            ...providerOptions,
            manifest:
              providerOptions?.manifest ??
              (async (adapter, override) => {
                const { manifest } = await engine.resolveActionManifest(
                  adapter,
                  override,
                  librarySources,
                );
                return validateRecipeActionManifestDocument(manifest);
              }),
            stream,
          });
          await finalize();
          return code;
        };
        return options.fix === true
          ? shared.withCommandJournal('doctor', ['doctor', ...invocation.argv], execute, {
              target: context.target.value,
              runtimeDir: context.project!.runtimeDir,
            })
          : execute();
      },
    );
  } catch (error) {
    if (stream?.enabled) {
      const shared = await import('@farmslot/recipe-cli/harness');
      stream.error({ ...errorEnvelope('doctor', error).error }, error);
      process.exitCode = shared.failStream(stream, error, 'DOCTOR_FAILED', shared.EXIT.runtime);
    } else emit.fail(error);
  } finally {
    restoreStdout();
    releaseResult();
  }
}

export interface ProjectConformanceResult {
  context: HarnessContext;
  report: RecipeConformanceReport;
  reportPath: string;
}

/** Check through the same authorized provider and preflight used by execution. */
async function prepareProjectConformance(
  checkout: string | undefined,
  options: CliOptions,
): Promise<
  ProjectConformanceResult & {
    checkOptions: RecipeConformanceOptions;
    headless: boolean;
    captureRequired: boolean;
    hudRequired: boolean;
  }
> {
  const shared = await import('@farmslot/recipe-cli/harness');
  const selected = shared.optionStrings(options, 'recipe') ?? [];
  const suppliedParams = shared.optionStrings(options, 'param') ?? [];
  if (suppliedParams.length && !selected.length) {
    throw shared.usageError(
      '--param requires --recipe to select the invocation receiving those parameters.',
    );
  }
  return shared.withProjectRecipeHost(
    await projectRecipeHostOptions('doctor', checkout, options),
    async ({ context, provider, engine, librarySources: sources, cli }) => {
      const binding = context.project!;
      const params = parseRecipeParamAssignments(suppliedParams);
      const recipes = selected.length
        ? selected.map((recipe) => ({ recipe, params }))
        : binding.checks;
      if (!recipes?.length) {
        throw shared.usageError(
          'Declare recipe.checks in the selected project or pass --recipe <ref>.',
        );
      }
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
      const cliModule = fileURLToPath(import.meta.url);
      implementationSources.push({
        name: '@farmslot/cli',
        root: shared.recipePackageRoot(cliModule),
        module: cliModule,
      });
      const providerPackage = path.join(binding.provider.root, 'package.json');
      if (existsSync(providerPackage)) addDependencies(providerPackage, 'provider:');
      const runtimeConfig = context.runtimeConfigPath;
      const checkOptions: RecipeConformanceOptions = {
        project: binding.name,
        app: binding.app,
        domain: shared.optionString(options, 'domain') ?? binding.domain,
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
        cli: {
          ...cli,
          ...(options.live === true
            ? { proof: true, teardownProofTarget: String(options.teardownTarget) }
            : {}),
        },
        recipes,
        libraryRefsOnly: selected.length === 0,
      };
      const report = await shared.checkRecipeConformance(engine, checkOptions);
      const captureRequired = !provider.runtime.headless;
      const restoreVisualEnvironment = shared.activateRecipeRuntimeEnvironment(
        provider.runtime.id,
        binding.checkoutRoot,
        shared.recipeRunOptionsFromCli(provider.runtime.id, cli),
      );
      let hudRequired: boolean;
      try {
        hudRequired = captureRequired && provider.runtime.run?.autoHud?.() !== false;
      } finally {
        restoreVisualEnvironment();
      }
      report.checks.push(
        {
          id: 'capture.support',
          required: false,
          status: captureRequired ? 'pass' : 'unsupported',
          message: captureRequired ? 'supported' : 'headless',
        },
        {
          id: 'hud.support',
          required: false,
          status: hudRequired ? 'pass' : 'unsupported',
          message: hudRequired ? 'supported' : provider.runtime.headless ? 'headless' : 'opaque',
        },
      );
      const saved = shared.optionString(options, 'checkReport');
      const reportPath = saved
        ? path.resolve(saved)
        : await shared.writeRecipeConformanceReport(
            artifactsDir,
            report,
            shared.optionString(options, 'reportName'),
          );
      return {
        context,
        report,
        reportPath,
        checkOptions,
        headless: provider.runtime.headless,
        captureRequired,
        hudRequired,
      };
    },
  );
}

/** Static inspection never receives execution authority; a live smoke gets a separate scoped host. */
export async function runProjectConformance(
  checkout: string | undefined,
  options: CliOptions,
): Promise<ProjectConformanceResult> {
  const shared = await import('@farmslot/recipe-cli/harness');
  const live = shared.optionFlag(options, 'live');
  const recipes = shared.optionStrings(options, 'recipe') ?? [];
  const smokeTarget = shared.optionString(options, 'smokeTarget');
  const teardownTarget = shared.optionString(options, 'teardownTarget');
  const timeoutMs = Number(shared.optionString(options, 'liveTimeoutMs') ?? '120000');
  const savedPath = shared.optionString(options, 'checkReport');
  const reportName = shared.optionString(options, 'reportName');
  if (reportName && (path.basename(reportName) !== reportName || !reportName.endsWith('.json')))
    throw shared.usageError('--report-name must be a JSON filename without a directory.');
  if (reportName && savedPath)
    throw shared.usageError('--report-name and --check-report are separate operations.');
  if (live && savedPath)
    throw shared.usageError('--live and --check-report are separate operations.');
  const saved = savedPath
    ? (JSON.parse(readFileSync(path.resolve(savedPath), 'utf8')) as RecipeConformanceReport)
    : undefined;
  if (
    live &&
    (recipes.length !== 1 || !smokeTarget || !teardownTarget || options.disposable !== true)
  ) {
    throw shared.usageError(
      '--live requires one --recipe, --smoke-target, --teardown-target and --disposable.',
    );
  }
  if (live && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000)) {
    throw shared.usageError('--live-timeout-ms must be between 1 and 300000.');
  }
  const prepared = await prepareProjectConformance(checkout, options);
  let report = prepared.report;
  if (saved) {
    if (report.status !== 'pass')
      throw new Error('Saved report cannot be reused because current preflight failed.');
    shared.assertConformanceReportCurrent(saved, report.identity);
    if (saved.mode === 'live') {
      for (const check of saved.checks.filter((entry) => entry.required)) {
        const evidence = check.evidence!.live!;
        if (!shared.isPathWithin(prepared.checkOptions.artifactsDir, evidence.artifactDir)) {
          throw new Error('Saved live evidence is outside the selected project report directory.');
        }
        const current = await validateRecipeArtifactDirectory(evidence.artifactDir, {
          requireRunnerProvenance: true,
          liveProof: {
            smokeTarget: evidence.smokeTarget,
            teardownTarget: evidence.teardownTarget,
            captureRequired: prepared.captureRequired,
            hudRequired: prepared.hudRequired,
          },
        });
        if (current.status !== 'pass' || !isDeepStrictEqual(current.liveEvidence, evidence)) {
          throw new Error(
            'Saved live evidence changed or is incomplete; rerun doctor --conformance --live.',
          );
        }
      }
    }
    return { context: prepared.context, report: saved, reportPath: prepared.reportPath };
  }
  if (!live) return { context: prepared.context, report, reportPath: prepared.reportPath };
  const { checkOptions } = prepared;
  let started = false;
  try {
    if (report.status !== 'pass')
      throw new Error('Live smoke refused because conformance preflight failed.');
    const artifactDir = path.join(checkOptions.artifactsDir, 'live', randomUUID());
    const evidence = await shared.withRecipeSignals((parentSignal) =>
      withLiveRecipeAuthority(
        {
          context: prepared.context,
          headless: prepared.headless,
          options: { ...options, ...(checkout ? { target: path.resolve(checkout) } : {}) },
          signal: AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]),
        },
        async (signal) => {
          started = true;
          return shared.withProjectRecipeHost(
            {
              ...(await projectRecipeHostOptions('run', checkout, options)),
              signal,
              deferOutput: false,
            },
            async ({ context, engine, cli, librarySources, finalize }) => {
              const currentOptions = { ...checkOptions, context, librarySources };
              shared.assertConformanceReportCurrent(
                report,
                await shared.recipeConformanceIdentity(engine, currentOptions),
              );
              const stream = new shared.JsonStreamWriter('run', true, process.stderr);
              const parsed = {
                positional: [recipes[0]!, ...(shared.optionStrings(options, 'param') ?? [])],
                rawArgv: [],
                options: {
                  ...cli,
                  artifactsDir: artifactDir,
                  json: true,
                  jsonStream: true,
                  heal: 'off',
                  captureHudEvidence: prepared.hudRequired,
                },
              };
              const exitCode = await shared.withCommandJournal(
                'run',
                ['run', ...parsed.positional],
                () =>
                  shared.handleRun([], {
                    engine,
                    parsed,
                    librarySources,
                    signal,
                    stream,
                    beforeResult: finalize,
                  }),
                { target: context.target.value, runtimeDir: context.project!.runtimeDir },
              );
              if (exitCode !== 0)
                throw new Error(
                  `Live smoke failed with exit code ${exitCode}; artifacts: ${artifactDir}`,
                );
              const validated = await validateRecipeArtifactDirectory(artifactDir, {
                requireRunnerProvenance: true,
                liveProof: {
                  smokeTarget: smokeTarget!,
                  teardownTarget: teardownTarget!,
                  captureRequired: prepared.captureRequired,
                  hudRequired: prepared.hudRequired,
                },
              });
              if (!validated.liveEvidence || validated.status !== 'pass') {
                throw new Error(
                  `Live smoke evidence failed: ${validated.checks
                    .filter((check) => check.status === 'fail')
                    .map((check) => check.message)
                    .join('; ')}`,
                );
              }
              shared.assertConformanceReportCurrent(
                report,
                await shared.recipeConformanceIdentity(engine, currentOptions),
              );
              return validated.liveEvidence;
            },
          );
        },
      ),
    );
    report = {
      ...report,
      mode: 'live',
      checkedAt: new Date().toISOString(),
      checks: report.checks.map((check) =>
        check.required && check.evidence
          ? { ...check, evidence: { ...check.evidence, live: evidence } }
          : check,
      ),
      capabilities: [
        ...report.capabilities,
        { name: 'recipe.execution', status: 'verified' },
        { name: 'recipe.teardown', status: 'verified' },
      ],
    };
    report.status = shared.conformanceChecksPass(report.checks, 'live') ? 'pass' : 'fail';
  } catch (error) {
    report = {
      ...report,
      mode: 'live',
      status: 'fail',
      checkedAt: new Date().toISOString(),
      checks: [
        ...report.checks,
        {
          id: 'recipe.live',
          status: 'fail',
          required: true,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      capabilities: [
        ...report.capabilities,
        { name: 'recipe.execution', status: started ? 'failed' : 'unknown' },
        { name: 'recipe.teardown', status: 'unknown' },
      ],
    };
  }
  const reportPath = await shared.writeRecipeConformanceReport(
    checkOptions.artifactsDir,
    report,
    reportName,
  );
  return { context: prepared.context, report, reportPath };
}

async function renderProjectConformance(checkout: string | undefined, cmd: Command): Promise<void> {
  const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
  try {
    const result = await runProjectConformance(checkout, {
      ...cmd.optsWithGlobals(),
      json: isMachineMode(output),
    });
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
