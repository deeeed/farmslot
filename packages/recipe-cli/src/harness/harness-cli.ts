// createHarnessCli: the generic front door a product harness presets. It owns
// the commander program, grouped and per-command help, the version line, the
// strict public grammar, library hydration and dispatch; the host supplies its
// identity, adapters, commands and help prose.
import fs from 'node:fs';
import path from 'node:path';

import { Command, CommanderError } from 'commander';

import type { AdapterRegistry } from '@farmslot/adapter-sdk';

import { RECIPE_CLI_VERSION } from '../version.js';

import { handleCallHelp } from './commands/call.js';
import {
  type AdapterLoadOptions,
  adapterSelectionFailureOut,
  ensureAdapterLoaded,
  selectedAdapterId,
} from './adapter-plugins.js';
import { configureHarnessAdapters, detectAdapter, harnessAdapter } from './adapters.js';
import type { RecipeCatalog } from './catalog.js';
import { color } from './cli-color.js';
import {
  type CliUsageError,
  type CommandContract,
  optionValues,
  validatePublicInvocation,
} from './command-contract.js';
import { withCommandJournal } from './command-journal.js';
import { configureHarnessHost, type HarnessHostConfig, hostEnvName } from './host.js';
import { JsonStreamWriter } from './json-stream.js';
import { DEFAULT_RECIPE_RUNTIME_DIR } from './paths.js';

const RECIPE_CLI_PACKAGE = '@farmslot/recipe-cli';

interface CommandBase {
  name: string;
  /** `now`: process.exit(code) at once. `code`: set process.exitCode and let open work drain. */
  exit?: 'now' | 'code';
  /** Whether the host's `beforeDispatch` hook runs for this command. Default true. */
  nudge?: boolean;
  /** `argv` is everything after the command token. A thrown error exits with its `exitCode`, else 1. */
  run(argv: string[]): number | Promise<number>;
}

/** A command the grouped help lists and the public grammar checks. Default exit: `code`. */
export interface PublicHarnessCommand extends CommandBase {
  hidden?: false;
  aliases?: readonly string[];
  summary: string;
  example: string;
  /** Printed for `<command> --help`. */
  helpText: string;
  contract: CommandContract;
  /** Runs before the grammar check, library hydration and commander (a bootstrap command). */
  raw?: boolean;
}

/** Real routing absent from the help, with its own private grammar. Default exit: `now`. */
export interface HiddenHarnessCommand extends CommandBase {
  hidden: true;
}

export type HarnessCommand = PublicHarnessCommand | HiddenHarnessCommand;

export type HelpPaint = (style: string, text: string) => string;

export interface HarnessHelpGroup {
  title: string;
  blurb: string;
  commands: readonly string[];
}

export interface HarnessHelp {
  /** The commander program description. */
  description: string;
  /** The lines above the groups. */
  intro(paint: HelpPaint): string[];
  groups: readonly HarnessHelpGroup[];
  /** The lines below the groups, after one blank line. */
  footer(paint: HelpPaint): string[];
  /** The adapter a runtime context's `platform` names, when it is not an adapter id. */
  slotAdapter?(platform: string): string | undefined;
}

export interface HarnessCliOptions {
  host: HarnessHostConfig;
  adapters: AdapterRegistry;
  /** Makes every library this machine resolves visible (RECIPE_LIBRARY_PATH) before dispatch. */
  libraries?: { hydrate(target: string): Promise<void> };
  /** Public commands in the order "Valid commands" lists them, plus hidden ones. */
  commands: readonly HarnessCommand[];
  help: HarnessHelp;
  /** Runs once per invocation before any command (an update nudge). */
  beforeDispatch?(argv: readonly string[]): void;
  /** When set, `call <action> --help` renders the action's fields above call's help. */
  catalog?: RecipeCatalog;
  /** Turns a library-declared adapter into the host's adapter before it registers. */
  adopt?: AdapterLoadOptions['adopt'];
  /** Libraries the host configures (a config file), searched after the others for adapters. */
  configuredLibraries?(): AdapterLoadOptions['configured'];
  /** Retired option spellings and their replacements, for the unknown-option suggestion. */
  replacedOptions?: Readonly<Record<string, string>>;
}

export interface HarnessCliResult {
  exitCode: number;
  exit: 'now' | 'code';
}

export interface HarnessCli {
  /** Parse and dispatch `argv` (without node and script); never exits the process. */
  main(argv: readonly string[]): Promise<HarnessCliResult>;
  /** `main(process.argv.slice(2))`, then exit as the command asked. */
  run(argv?: readonly string[]): Promise<void>;
}

export function createHarnessCli(options: HarnessCliOptions): HarnessCli {
  const host = configureHarnessHost(options.host);
  configureHarnessAdapters(options.adapters);
  const publicCommands = options.commands.filter(
    (command): command is PublicHarnessCommand => !command.hidden,
  );
  const find = (token: string | undefined): HarnessCommand | undefined =>
    token === undefined
      ? undefined
      : (options.commands.find((command) => command.name === token) ??
        publicCommands.find((command) => command.aliases?.includes(token)));
  const packageVersion = readPackageVersion(host.packageRoot);
  const version =
    host.packageName === RECIPE_CLI_PACKAGE
      ? packageVersion
      : `${packageVersion}\n${RECIPE_CLI_PACKAGE} ${RECIPE_CLI_VERSION}`;
  const renderHelp = (): string => groupedHelp(options.help, publicCommands);

  async function main(argv: readonly string[]): Promise<HarnessCliResult> {
    const command = find(argv[0]);
    if (argv.length > 0 && command?.nudge !== false) options.beforeDispatch?.(argv);
    if (argv.length === 0) {
      process.stdout.write(renderHelp());
      return { exitCode: 0, exit: 'now' };
    }
    if (command && !command.hidden && command.raw) {
      return { exitCode: await dispatch(command, argv), exit: exitOf(command) };
    }

    // Public commands use a strict grammar before commander can consume a typo
    // as a value. Hidden commands keep their private grammar.
    if (!command?.hidden) {
      const usageError = validatePublicInvocation(argv, publicCommands, {
        replacedOptions: options.replacedOptions,
      });
      if (usageError) {
        writeUsageError(
          host.name,
          usageError,
          requested(argv, '--json'),
          requested(argv, '--json-stream'),
        );
        return { exitCode: 2, exit: 'now' };
      }
    }

    await options.libraries?.hydrate(targetFromArgv(argv));

    // A library-declared adapter loads only when the command selects it.
    if (command) {
      const refused = await loadSelectedAdapter(command.name, argv, {
        adopt: options.adopt,
        configured: options.configuredLibraries?.(),
      });
      if (refused !== undefined) return { exitCode: refused, exit: 'now' };
    }

    // Leaves own --help after `--`; commander would intercept it.
    if (command && hasPassthroughHelp(argv)) {
      return { exitCode: await dispatch(command, argv), exit: 'now' };
    }

    // `call <action> --help` renders the action's field schema; commander would
    // show only the generic call help, which follows it.
    const call = publicCommands.find((entry) => entry.name === 'call');
    if (options.catalog && call && isCallActionHelp(argv)) {
      const catalog = options.catalog;
      const exitCode = await mapErrors(() =>
        handleCallHelp(argv.slice(1), call.helpText, { catalog }),
      );
      return { exitCode, exit: 'now' };
    }

    let result: HarnessCliResult = { exitCode: 0, exit: 'code' };
    const program = new Command();
    program
      .name(host.name)
      .description(options.help.description)
      .version(version, '-v, --version', `Print the ${host.name} version`)
      .addHelpCommand(false)
      .helpOption('-h, --help', 'Show grouped help')
      .showHelpAfterError(`(run \`${host.name} --help\` for the full surface)`)
      .configureHelp({ formatHelp: renderHelp })
      .exitOverride();
    for (const entry of options.commands) {
      const registered = entry.hidden
        ? program.command(entry.name, { hidden: true }).allowUnknownOption().helpOption(false)
        : program
            .command(entry.name)
            .description(entry.summary)
            .allowUnknownOption()
            .helpOption('-h, --help', 'Show command help')
            .configureHelp({ formatHelp: () => `${entry.helpText}\n` });
      if (!entry.hidden && entry.aliases?.length) registered.aliases([...entry.aliases]);
      registered.argument('[args...]').action(async () => {
        const exitCode = entry.hidden
          ? await dispatch(entry, argv)
          : await withCommandJournal(entry.name, argv, () => dispatch(entry, argv));
        result = { exitCode, exit: exitOf(entry) };
      });
    }
    try {
      await program.parseAsync([...argv], { from: 'user' });
    } catch (error) {
      // Help, version and commander's own errors end here after printing.
      if (error instanceof CommanderError) return { exitCode: error.exitCode, exit: 'now' };
      throw error;
    }
    return result;
  }

  return {
    main,
    async run(argv = process.argv.slice(2)) {
      const { exitCode, exit } = await main(argv);
      if (exit === 'now') process.exit(exitCode);
      process.exitCode = exitCode;
    },
  };
}

// Loads the adapter the command selects (`selectedAdapterId`), if a library
// declares it. A refused plugin prints its code and next step; returns that exit.
async function loadSelectedAdapter(
  command: string,
  argv: readonly string[],
  load: Pick<AdapterLoadOptions, 'adopt' | 'configured'>,
): Promise<number | undefined> {
  const tokens = argv.slice(1);
  const selected = selectedAdapterId(tokens);
  if (selected === undefined) return undefined;
  try {
    await ensureAdapterLoaded(selected, { ...load, libraries: optionValues(tokens, '--library') });
    return undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      'userAction' in error &&
      typeof error.userAction === 'string'
    ) {
      return adapterSelectionFailureOut(requested(argv, '--json'), command, {
        code: error.code,
        message: error.message,
        userAction: error.userAction,
      });
    }
    return mapErrors(() => {
      throw error;
    });
  }
}

function exitOf(command: HarnessCommand): 'now' | 'code' {
  return command.exit ?? (command.hidden ? 'now' : 'code');
}

function dispatch(command: HarnessCommand, argv: readonly string[]): Promise<number> {
  return mapErrors(() => command.run(argv.slice(1)));
}

// The one place a command's failure becomes an exit code: a CliError carries
// its own (usage 2, validation 5), anything else is 1.
async function mapErrors(execute: () => number | Promise<number>): Promise<number> {
  try {
    return await execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error !== null &&
      typeof error === 'object' &&
      'exitCode' in error &&
      typeof error.exitCode === 'number'
      ? error.exitCode
      : 1;
  }
}

function readPackageVersion(packageRoot: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function groupedHelp(help: HarnessHelp, commands: readonly PublicHarnessCommand[]): string {
  const out: HelpPaint = (style, text) => color(style, text, { stream: process.stdout });
  const lines = [...help.intro(out)];
  const binEnv = hostEnvName('BIN');
  const bin = process.env[binEnv];
  const runMode = process.env[hostEnvName('RUN_MODE')];
  if (bin) {
    lines.push('');
    lines.push(
      `${out('warn', 'DEV OVERRIDE ACTIVE')} — this run is served by ${binEnv}=${out('path', bin)} (unset it to return to the installed/global bin).`,
    );
  }
  if (bin && runMode) {
    lines.push(
      `${out('label', 'running from:')} ${out('path', runMode)} (source checkout; dist shadows src when both exist)`,
    );
  }
  const slotLine = detectedSlotLine(out, help.slotAdapter);
  if (slotLine) {
    lines.push('');
    lines.push(slotLine);
  }
  for (const group of help.groups) {
    lines.push('');
    lines.push(`${out('label', group.title)} — ${group.blurb}:`);
    for (const name of group.commands) {
      const command = commands.find((entry) => entry.name === name);
      lines.push(`  ${out('cmd', name.padEnd(10))} ${command?.summary ?? ''}`);
      lines.push(`               ${out('comment', command?.example ?? '')}`);
    }
  }
  lines.push('');
  lines.push(...help.footer(out));
  return `${lines.join('\n')}\n`;
}

// The slot context the orchestrator's prepare wrote into the checkout, when
// help runs from inside one. Presence-gated: no context, no line.
function detectedSlotLine(out: HelpPaint, slotAdapter: HarnessHelp['slotAdapter']): string | null {
  const ctxPath = path.join(
    process.cwd(),
    process.env.RECIPE_RUNTIME_DIR || DEFAULT_RECIPE_RUNTIME_DIR,
    'agentic-runtime.json',
  );
  try {
    const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8')) as Record<string, unknown>;
    const platform = typeof ctx.platform === 'string' ? ctx.platform : undefined;
    const adapter =
      (platform ? slotAdapter?.(platform) : undefined) ?? detectAdapter(process.cwd());
    const parts: string[] = [];
    if (ctx.slotId) parts.push(`slot ${out('ok', String(ctx.slotId))}`);
    if (ctx.simulator) parts.push(`device ${out('ok', String(ctx.simulator))}`);
    const devServerPort = ctx.watcherPort ?? ctx.devServerPort ?? ctx.metroPort;
    const surface = adapter ? harnessAdapter(adapter) : undefined;
    if (surface && !surface.headless && devServerPort) {
      parts.push(`${surface.devServer.label} :${out('ok', String(devServerPort))}`);
    }
    if (ctx.gitBranch) parts.push(`branch ${out('info', String(ctx.gitBranch))}`);
    if (parts.length === 0) return null;
    return `${out('label', 'SLOT')} — this checkout is a prepared slot: ${parts.join(' · ')}`;
  } catch {
    return null;
  }
}

function writeUsageError(
  hostName: string,
  error: CliUsageError,
  json: boolean,
  jsonStream: boolean,
): void {
  if (jsonStream) {
    const stream = new JsonStreamWriter(error.command, true);
    stream.error({ code: error.code, message: error.message, userAction: error.userAction });
    stream.complete('fail', 2);
  } else if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          command: error.command,
          status: 'fail',
          error: { code: error.code, message: error.message, userAction: error.userAction },
          exitCode: 2,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const scope = error.command === hostName ? '' : ` ${error.command}`;
    process.stderr.write(`✗ ${hostName}${scope}: ${error.message}\n  Next: ${error.userAction}\n`);
  }
}

// The checkout a run is about, read before commander parses: library locations
// resolve against it and every command accepts the same --target spelling.
function targetFromArgv(argv: readonly string[]): string {
  const index = argv.indexOf('--target');
  const separate = index !== -1 ? argv[index + 1] : undefined;
  const inline = argv
    .find((argument) => argument.startsWith('--target='))
    ?.slice('--target='.length);
  return path.resolve(separate ?? inline ?? process.cwd());
}

function beforePassthrough(argv: readonly string[]): readonly string[] {
  const divider = argv.indexOf('--');
  return divider === -1 ? argv : argv.slice(0, divider);
}

function hasPassthroughHelp(argv: readonly string[]): boolean {
  const divider = argv.indexOf('--');
  if (divider === -1) return false;
  return argv.slice(divider + 1).some((arg) => arg === '-h' || arg === '--help');
}

// Requires the grammar call enforces (the action first, before flags), so
// `call --help` still gets commander's generic call help.
function isCallActionHelp(argv: readonly string[]): boolean {
  if (argv[0] !== 'call') return false;
  if (!argv[1] || argv[1].startsWith('-')) return false;
  const scope = beforePassthrough(argv);
  return scope.includes('--help') || scope.includes('-h');
}

function requested(argv: readonly string[], option: '--json' | '--json-stream'): boolean {
  const scope = beforePassthrough(argv);
  return option === '--json'
    ? scope.some((argument) => argument === '--json' || argument.startsWith('--json='))
    : scope.includes('--json-stream');
}
