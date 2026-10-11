import { existsSync } from 'node:fs';
import path from 'node:path';

import { Command, Option } from 'commander';

import { resolveSlotPoolDir } from '@farmslot/protocol/node/slot-by-repo';
import type {
  CliOptions,
  CommandContract,
  JsonStreamWriter,
  ProjectCommandInvocation,
  ProjectRecipeHostOptions,
} from '@farmslot/recipe-cli/harness';

import { createEmitter, errorEnvelope, isMachineMode } from '../envelope.js';
import { repoRoot, resolveWorkspace } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

export function collectRecipeOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function recipeProjectOptions(command: Command): Command {
  return command
    .option('--project <name>', 'Select a registered project')
    .option('--projects-dir <path>', 'Operator-owned project registry')
    .option(
      '--authorize-provider <module>',
      'Authorize an exact discovered provider source',
      collectRecipeOption,
      [],
    )
    .option('--adapter <name>', 'Select the project runtime')
    .option('--app <name>', 'Select a monorepo app')
    .option('--slot <id>', 'Select one pool slot')
    .option('--device <id>', 'Select one device')
    .option('--platform <name>', 'Select a provider platform')
    .option('--watcher-port <port>', 'Select the app transport port')
    .option('--cdp-port <port>', 'Select the CDP transport port')
    .option('--runtime-dir <path>', 'Target-relative recipe runtime directory')
    .option('--library <name=path>', 'Override a recipe library', collectRecipeOption, []);
}

/** Commander consumes host options; provider flags remain for strict validation after import. */
export function projectCommandInvocation(
  cmd: Command,
  contract: Omit<CommandContract, 'options'>,
): ProjectCommandInvocation {
  const values = cmd.optsWithGlobals();
  const argv = [...cmd.args];
  const specs: CommandContract['options'] = Object.fromEntries(
    cmd.options
      .filter((option) => option.long)
      .map((option) => [
        option.long!,
        {
          kind: option.required ? 'value' : option.optional ? 'optional-value' : 'boolean',
          ...(option.argChoices ? { choices: option.argChoices } : {}),
        },
      ]),
  );
  for (const option of cmd.options) {
    if (!option.long) continue;
    const value: unknown = values[option.attributeName()];
    if (value === undefined || value === false) continue;
    if (value === true) argv.push(option.long);
    else
      for (const entry of Array.isArray(value) ? value : [value])
        if (option.optional) argv.push(`${option.long}=${String(entry)}`);
        else argv.push(option.long, String(entry));
  }
  if (values.json) argv.push('--json');
  return { argv, contract: { ...contract, options: { ...specs, '--json': { kind: 'boolean' } } } };
}

export function registerProjectExecutionCommand(
  recipe: Command,
  operation: 'run' | 'call',
  standalone?: (recipePath: string, params: string[], command: Command) => Promise<void>,
): void {
  const command = recipeProjectOptions(
    recipe
      .command(operation)
      .description(
        `Run ${operation === 'run' ? 'a recipe' : 'one action'} through the selected project provider`,
      )
      .argument(
        '[args...]',
        `${operation === 'run' ? 'Recipe' : 'Action'} followed by key=value inputs`,
      )
      .allowUnknownOption(),
  )
    .option('--target <path>', 'Checkout to execute against')
    .option('--artifacts-dir <path>', 'Checkout-relative artifact directory')
    .option('--action-manifest <path>', 'Select an action manifest')
    .addOption(
      new Option('--heal <policy>', 'Healing policy').choices(['off', 'infra-only', 'auto']),
    )
    .addOption(new Option('--hud <mode>', 'Evidence HUD').choices(['show', 'hide']))
    .addOption(new Option('--record-video [mode]', 'Record evidence').choices(['full-run', 'off']))
    .option('--source-trust <trust>', 'Explicit recipe source trust')
    .option('--source-kind <kind>', 'Explicit recipe source kind')
    .option('--source-name <name>', 'Recipe source name')
    .option('--source-digest <digest>', 'Recipe source digest')
    .option('--approve-plan <digest>', 'Approve an exact execution plan')
    .option('--list', `List ${operation === 'run' ? 'recipes' : 'callable actions'}`)
    .option('--domain <name>', 'Filter listed actions by domain')
    .option('--source <name>', 'Filter listed actions by source')
    .addOption(
      new Option('--sort <field>', 'Group listed actions').choices(['domain', 'name', 'library']),
    );
  if (operation === 'run') {
    command
      .option('--plan', 'Validate the complete execution plan without running it')
      .option('--describe', 'Describe one recipe and its dependencies')
      .option('--proof', 'With --plan, preflight behavioral proof bindings')
      .option('--json-stream', 'Stream JSONL progress and a terminal result');
    if (standalone)
      command
        .option(
          '--project-root <path>',
          'Use explicit standalone core execution with a manifest and artifact directory',
        )
        .option(
          '--library-source <spec>',
          'Standalone recipe library source; repeatable',
          collectRecipeOption,
          [],
        );
  }
  command.action(async (_args: string[], _opts: unknown, cmd: Command) => {
    const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
    const emit = createEmitter(output, cmd);
    const options: CliOptions = { ...cmd.optsWithGlobals(), json: isMachineMode(output) };
    let stream: JsonStreamWriter | undefined;
    let restoreStdout = () => {};
    let releaseResult = () => {};
    try {
      const shared = await import('@farmslot/recipe-cli/harness');
      if (operation === 'run' && options.jsonStream === true) {
        stream = new shared.JsonStreamWriter('run', true);
        releaseResult = stream.deferResult();
        restoreStdout = stream.isolateStdout();
      }
      const invocation = projectCommandInvocation(cmd, {
        positionals: [{ label: operation === 'run' ? 'recipe' : 'action' }],
        minimumPositionals: 1,
        requiredUnless: ['--list'],
        noPositionalsWith: ['--list'],
        variadic: { label: 'key=value', pattern: /^[^=\s]+=.*/u },
        refine: (_positionals, seen, failure) =>
          operation === 'run' && seen.has('--proof') && !seen.has('--plan')
            ? failure.usage('CLI_INVALID_OPTION_VALUE', '--proof requires --plan.')
            : null,
      });
      if (standalone) {
        // The original complete manifest/artifact invocation keeps core-only semantics.
        // Project options select the provider path; preview flags can never become core execution.
        const flags = new Set([
          '--project-root',
          '--artifacts-dir',
          '--action-manifest',
          '--adapter',
          '--library-source',
          '--source-trust',
          '--source-kind',
          '--source-name',
          '--source-digest',
          '--approve-plan',
          '--json',
        ]);
        const original = {
          ...invocation,
          contract: {
            ...invocation.contract,
            requiredUnless: [],
            noPositionalsWith: [],
            options: Object.fromEntries(
              Object.entries(invocation.contract.options).filter(([flag]) => flags.has(flag)),
            ),
          },
        };
        const originalInvocation =
          options.artifactsDir !== undefined &&
          options.actionManifest !== undefined &&
          shared.validatePublicInvocation(
            [operation, ...invocation.argv],
            [
              {
                name: operation,
                example: 'farmslot recipe run --help',
                contract: original.contract,
              },
            ],
          ) === null;
        if (options.projectRoot !== undefined || originalInvocation) {
          const parsed = shared.parseProjectInvocation(operation, original);
          await standalone(parsed.positional[0]!, parsed.positional.slice(1), cmd);
          return;
        }
      }
      if (
        options.librarySource !== undefined &&
        shared.optionStrings(options, 'librarySource')?.length
      ) {
        throw Object.assign(
          shared.usageError('--library-source belongs to standalone execution.'),
          {
            code: 'CLI_INVALID_OPTION_VALUE',
            userAction:
              'use --library name=path for a project, or --project-root <path> --action-manifest <path> --artifacts-dir <path> for standalone execution',
          },
        );
      }
      process.exitCode = await shared.withProjectRecipeHost(
        {
          ...(await projectRecipeHostOptions(operation, undefined, options)),
          invocation,
        },
        ({ context, engine, invocation: parsed, cli, signal, finalize, librarySources }) => {
          const execute = () =>
            (operation === 'run' ? shared.handleRun : shared.handleCall)([...invocation.argv], {
              engine,
              parsed,
              librarySources,
              stream,
              signal,
              beforeResult: finalize,
            });
          return shared.isRecipeExecution(operation, cli)
            ? shared.withCommandJournal(operation, [operation, ...invocation.argv], execute, {
                target: context.target.value,
                runtimeDir: context.project!.runtimeDir,
              })
            : execute();
        },
      );
    } catch (error) {
      if (stream?.enabled) {
        const shared = await import('@farmslot/recipe-cli/harness');
        stream.error({ ...errorEnvelope(`recipe.${operation}`, error).error }, error);
        process.exitCode = shared.failStream(stream, error, 'RUN_FAILED', shared.EXIT.runtime);
      } else emit.fail(error);
    } finally {
      restoreStdout();
      releaseResult();
    }
  });
}

/** Doctor and execution resolve the same installed registry and pool before provider import. */
export async function projectRecipeHostOptions(
  command: string,
  checkout: string | undefined,
  options: CliOptions,
): Promise<ProjectRecipeHostOptions> {
  const shared = await import('@farmslot/recipe-cli/harness');
  const target = checkout ?? shared.optionString(options, 'target');
  const tokens: string[] = [];
  if (target) tokens.push('--target', path.resolve(target));
  for (const [key, flag] of Object.entries({
    project: '--project',
    adapter: '--adapter',
    platform: '--platform',
    app: '--app',
    slot: '--slot',
    device: '--device',
    cdpPort: '--cdp-port',
    watcherPort: '--watcher-port',
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
    path.resolve(
      process.env.FARMSLOT_ROOT?.trim() || workspace?.farmslotDir || repoRoot,
      'projects',
    );
  const diagnosis = recipeProjectOptions(new Command());
  for (const option of diagnosis.options)
    diagnosis.setOptionValue(option.attributeName(), options[option.attributeName()]);
  diagnosis.setOptionValue('projectsDir', existsSync(registry) ? registry : undefined);
  diagnosis.setOptionValue('json', true);
  diagnosis.args = [path.resolve(target ?? process.cwd())];
  const doctorArgs = projectCommandInvocation(diagnosis, {}).argv;
  return {
    tokens,
    projectsDir: existsSync(registry) ? registry : undefined,
    slotPoolDir,
    command,
    options,
    deferOutput: options.json === true && options.jsonStream !== true,
    authorizedProviders: shared.optionStrings(options, 'authorizeProvider'),
    hostHints: {
      supportsLast: false,
      journaledCommands: ['run', 'call', 'launch', 'reload', 'stop', 'doctor'],
      doctorCommand: 'farmslot doctor',
      doctorHint: `farmslot doctor ${doctorArgs.map(shared.shellQuoteArg).join(' ')}`,
    },
  };
}

export function registerProjectActionsCommand(recipe: Command): void {
  recipeProjectOptions(
    recipe
      .command('actions')
      .description('Discover actions from the selected project provider and libraries')
      .argument('[query]', 'Search the action catalog'),
  )
    .option('--target <path>', 'Checkout to inspect')
    .option('--action <name>', 'Show one action and its input schema')
    .option('--category <name>', 'Filter by action category')
    .option('--categories', 'List action categories')
    .option('--matrix', 'Show action support across the provider runtimes')
    .option('--raw', 'Print the resolved action manifest')
    .option('--action-manifest <path>', 'Select an action manifest')
    .action(async (query: string | undefined, _: unknown, cmd: Command) => {
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      const options: CliOptions = { ...cmd.optsWithGlobals(), json: isMachineMode(output) };
      try {
        const shared = await import('@farmslot/recipe-cli/harness');
        process.exitCode = await shared.withProjectRecipeHost(
          await projectRecipeHostOptions('actions', undefined, options),
          ({ engine, cli, librarySources }) =>
            shared.handleActions(
              {
                positional: query ? [query] : [],
                rawArgv: [],
                options: cli,
              },
              { catalog: engine, librarySources },
            ),
        );
      } catch (error) {
        emit.fail(error);
      }
    });
}

export function registerProjectLifecycleCommands(recipe: Command): void {
  for (const operation of ['status', 'launch', 'reload', 'stop', 'logs'] as const) {
    const command = recipeProjectOptions(
      recipe
        .command(operation)
        .description(
          `${operation[0]!.toUpperCase()}${operation.slice(1)} the selected project runtime`,
        ),
    ).option('--target <path>', 'Checkout to inspect or operate');
    if (operation === 'launch')
      command
        .argument('[args...]', 'Provider-specific launch options')
        .allowUnknownOption()
        .option('--verify', 'Verify the launched runtime is ready')
        .option('--json-stream', 'Stream JSONL progress and a terminal result')
        .addOption(
          new Option('--heal <policy>', 'Healing policy').choices(['off', 'infra-only', 'auto']),
        );
    if (operation === 'status')
      command
        .option('--fast', 'Skip live readiness probes')
        .option('--watch', 'Watch the current task without changing it')
        .option('--task <path>', 'Inspect a specific task')
        .option('--all-devices', 'Include all discovered devices');
    if (operation === 'logs')
      command
        .option('--source <name>', 'Select one runtime log source')
        .option('--full', 'Follow the entire selected log without filtering')
        .option('--lines <count>', 'Number of initial log lines', '20')
        .option('--follow', 'Follow the selected log until interrupted');
    command.action(async (...args: unknown[]) => {
      const cmd = args.at(-1) as Command;
      const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
      const emit = createEmitter(output, cmd);
      const options: CliOptions = { ...cmd.optsWithGlobals(), json: isMachineMode(output) };
      let stream: JsonStreamWriter | undefined;
      let releaseResult = () => {};
      let restoreStdout = () => {};
      try {
        const shared = await import('@farmslot/recipe-cli/harness');
        if (operation === 'launch' && options.jsonStream === true) {
          stream = new shared.JsonStreamWriter('launch', true);
          releaseResult = stream.deferResult();
          restoreStdout = stream.isolateStdout();
        }
        const invocation = projectCommandInvocation(cmd, {});
        process.exitCode = await shared.withProjectRecipeHost(
          {
            ...(await projectRecipeHostOptions(operation, undefined, options)),
            invocation,
          },
          async ({ context, provider, invocation: parsed, finalize }) => {
            if (!parsed) throw new Error('Project lifecycle invocation was not validated.');
            // Repeatable library/authorization selectors are resolved by the host.
            // The existing lifecycle SDK accepts scalar runtime options only.
            const flags = {
              positional: parsed.positional,
              options: Object.fromEntries(
                Object.entries(parsed.options).filter(
                  (entry): entry is [string, string | boolean] =>
                    typeof entry[1] === 'string' || typeof entry[1] === 'boolean',
                ),
              ),
            };
            return shared.withCommandJournal(
              operation,
              [operation, ...invocation.argv],
              async () => {
                let code: number;
                switch (operation) {
                  case 'status':
                    code = await shared.handleStatus(parsed, provider.commandOptions?.status);
                    break;
                  case 'launch':
                    code = await shared.handleLaunch([], { parsed: flags, stream });
                    break;
                  case 'reload':
                    code = await shared.handleReload([], flags);
                    break;
                  case 'stop':
                    code = await shared.handleStop([], {
                      ...provider.commandOptions?.stop,
                      parsed,
                    });
                    break;
                  case 'logs':
                    code = await shared.handleLogs(parsed);
                    break;
                }
                await finalize();
                return code;
              },
              { target: context.target.value, runtimeDir: context.project!.runtimeDir },
            );
          },
        );
      } catch (error) {
        if (stream?.enabled) {
          const shared = await import('@farmslot/recipe-cli/harness');
          stream.error({ ...errorEnvelope(`recipe.${operation}`, error).error }, error);
          process.exitCode = shared.failStream(stream, error, 'LAUNCH_FAILED', shared.EXIT.runtime);
        } else emit.fail(error);
      } finally {
        restoreStdout();
        releaseResult();
      }
    });
  }
}
