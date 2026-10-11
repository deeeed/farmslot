import { existsSync } from 'node:fs';
import path from 'node:path';

import { type Command, Option } from 'commander';

import { resolveSlotPoolDir } from '@farmslot/protocol/node/slot-by-repo';
import type {
  CliOptions,
  CommandContract,
  JsonStreamWriter,
  ProjectCommandInvocation,
  ProjectRecipeHostOptions,
} from '@farmslot/recipe-cli/harness';

import { createEmitter, isMachineMode } from '../envelope.js';
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
    .option('--cdp-port <port>', 'Select the CDP transport port')
    .option('--runtime-dir <path>', 'Target-relative recipe runtime directory')
    .option('--library <name=path>', 'Override a recipe library', collectRecipeOption, []);
}

/** Commander consumes host options; provider flags remain for strict validation after import. */
function projectCommandInvocation(
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
    .option('--platform <name>', 'Select a provider platform')
    .option('--watcher-port <port>', 'Select the app transport port')
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
      .option('--proof', 'Preflight behavioral proof bindings')
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
    try {
      const shared = await import('@farmslot/recipe-cli/harness');
      if (operation === 'run' && options.jsonStream === true) {
        stream = new shared.JsonStreamWriter('run', true);
        restoreStdout = stream.isolateStdout();
      }
      const invocation = projectCommandInvocation(cmd, {
        positionals: [{ label: operation === 'run' ? 'recipe' : 'action' }],
        minimumPositionals: 1,
        requiredUnless: ['--list'],
        noPositionalsWith: ['--list'],
        variadic: { label: 'key=value', pattern: /^[^=\s]+=.*/u },
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
        throw shared.usageError(
          '--library-source belongs to standalone --project-root execution; use --library name=path for a project.',
        );
      }
      process.exitCode = await shared.withProjectRecipeHost(
        {
          ...(await projectRecipeHostOptions(operation, undefined, options)),
          invocation,
        },
        ({ engine, invocation: parsed, signal, finalize, librarySources }) =>
          (operation === 'run' ? shared.handleRun : shared.handleCall)([...invocation.argv], {
            engine,
            parsed,
            librarySources,
            stream,
            signal,
            beforeResult: finalize,
          }),
      );
    } catch (error) {
      if (stream?.enabled) {
        const shared = await import('@farmslot/recipe-cli/harness');
        process.exitCode = shared.failStream(stream, error, 'RUN_FAILED', shared.EXIT.runtime);
      } else emit.fail(error);
    } finally {
      restoreStdout();
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
    path.join(workspace?.farmslotDir ?? process.env.FARMSLOT_ROOT ?? repoRoot, 'projects');
  return {
    tokens,
    projectsDir: existsSync(registry) ? registry : undefined,
    slotPoolDir,
    command,
    options,
    deferOutput: options.json === true && options.jsonStream !== true,
    authorizedProviders: shared.optionStrings(options, 'authorizeProvider'),
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
