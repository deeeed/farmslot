import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import {
  adapterChoices,
  adapterPlugin,
  AdapterPluginError,
  booleanOption,
  type CommandContract,
  configureHarnessAdapters,
  configureHarnessHost,
  contextAdapter,
  type ContractedCommand,
  contractOptions,
  createHarnessCli,
  detectAdapter,
  formatHarnessContext,
  harnessAdapters,
  type HarnessCliOptions,
  type HarnessCommand,
  harnessContext,
  harnessHost,
  optionalValueOption,
  optionValues,
  publicCommandTokens,
  type PublicHarnessCommand,
  readCommandJournal,
  type RecipeCatalog,
  setHarnessContext,
  usageError,
  validatePublicInvocation,
  valueOption,
} from '../src/harness/index.js';
import { RECIPE_CLI_VERSION } from '../src/version.js';

const DEFAULT_HOST = harnessHost();
const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-harness-cli-'));
  roots.push(root);
  return root;
}

function shopHost(packageRoot = tempRoot(), version = '1.2.3') {
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version }));
  return {
    name: 'shop-harness',
    product: 'Shop',
    envPrefix: 'SHOP_HARNESS',
    recipeEnvPrefix: 'SHOP_RECIPE',
    packageName: '@acme/shop-harness',
    packageRoot,
    bin: 'bin/shop-harness',
  };
}

function fakeAdapter(id: string): PlatformAdapter {
  return {
    id,
    sdkVersion: ADAPTER_SDK_VERSION,
    headless: false,
    resolveSlotPorts() {},
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    devServer: {
      label: `${id}-server`,
      describe: () => `${id} dev server`,
      stop: () => ({ kind: 'stopped', status: 0, summary: `stopped ${id} dev server` }),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: { launch: `launch ${id}`, relaunch: `relaunch ${id}`, runtimeProbeRecovery: () => 'r' },
    actions: {
      manifestPath: () => `/manifests/${id}.json`,
      semantic: [],
      cdpTarget: { transport: 'none', probePath: '/json/version' },
    },
    harness: {
      install: { entry: 'install.mjs', fallback: 'install.mjs', node: true },
      cleanup: { entry: 'cleanup.mjs', fallback: 'cleanup.mjs', node: true },
      verify: () => ({ error: 'no verify' }),
    },
    runtimeContext: { forbiddenFields: [] },
    launch: async () => 0,
  };
}

const HELP = { '--help': booleanOption(), '-h': booleanOption() };
const JSON_FLAG = { '--json': booleanOption(), '--json-stream': booleanOption() };
const TARGET = { '--target': valueOption() };

const calls: { command: string; argv: string[] }[] = [];
function command(
  name: string,
  contract: CommandContract,
  extra: Partial<PublicHarnessCommand> = {},
): HarnessCommand {
  return {
    name,
    summary: `${name} summary`,
    example: `shop-harness ${name} example`,
    helpText: `shop-harness ${name} [flags]\n\n  ${name} help`,
    contract,
    run: (argv) => {
      calls.push({ command: name, argv });
      return 0;
    },
    ...extra,
  };
}

function shopCommands(): HarnessCommand[] {
  return [
    command('status', { options: contractOptions(HELP, JSON_FLAG, TARGET) }, { aliases: ['home'] }),
    command('launch', {
      options: contractOptions(HELP, JSON_FLAG, TARGET, {
        '--surface': valueOption(['fullscreen', 'sidepanel']),
      }),
      positionals: [{ label: 'platform', choices: ['ios', 'android'] }],
    }),
    command('run', {
      options: contractOptions(HELP, JSON_FLAG, TARGET, { '--list': booleanOption() }),
      positionals: [{ label: 'recipe' }],
      minimumPositionals: 1,
      requiredUnless: ['--list'],
      noPositionalsWith: ['--list'],
      variadic: { label: 'key=value', pattern: /^[^=\s]+=.*/u },
      missingPositionalAction: (example) =>
        `List recipes: shop-harness run --list\n  Example: ${example}`,
    }),
    command('call', {
      options: contractOptions(HELP, JSON_FLAG, TARGET, {
        '--slot': optionalValueOption(),
        '--list': booleanOption(),
      }),
      positionals: [{ label: 'action' }],
      minimumPositionals: 0,
      requiredUnless: ['--list'],
      noPositionalsWith: ['--list'],
      leadingPositionals: 1,
      variadic: { label: 'key=value', pattern: /^[^=\s]+=.*/u },
      missingPositionalAction: (example) =>
        `List actions: shop-harness call --list\n  Example: ${example}`,
    }),
    command('install', { options: contractOptions(HELP, TARGET), allowPassthrough: true }),
    command('update', { options: contractOptions(HELP) }, { exit: 'now', nudge: false }),
    command('setup', { options: contractOptions(HELP) }, { raw: true, nudge: false }),
    command(
      'fail',
      { options: contractOptions(HELP) },
      {
        run: () => {
          throw usageError('fail needs a reason.');
        },
      },
    ),
    command(
      'crash',
      { options: contractOptions(HELP) },
      {
        run: () => {
          throw new Error('crashed');
        },
      },
    ),
    {
      name: 'runtime-probe',
      hidden: true,
      run: (argv) => {
        calls.push({ command: 'runtime-probe', argv });
        return 3;
      },
    },
  ];
}

function cliOptions(overrides: Partial<HarnessCliOptions> = {}): HarnessCliOptions {
  const registry = createAdapterRegistry();
  registry.register(fakeAdapter('web'));
  return {
    host: shopHost(),
    adapters: registry,
    commands: shopCommands(),
    help: {
      description: 'the Shop harness',
      intro: (paint) => [`${paint('bold', 'shop-harness')} — the Shop recipe loop.`],
      groups: [
        { title: 'DAILY', blurb: 'every day', commands: ['status', 'launch'] },
        { title: 'PROVE', blurb: 'run recipes', commands: ['run'] },
      ],
      footer: () => ['See README.md.'],
      slotAdapter: (platform) => (platform === 'web-extension' ? 'web' : undefined),
    },
    ...overrides,
  };
}

// Captures everything written to stdout/stderr while `run` executes.
async function capture<T>(
  run: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  // node:test reports the previous test on a later tick; swapping stdout first would swallow it.
  await new Promise((resolve) => setImmediate(resolve));
  const out: string[] = [];
  const err: string[] = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await run();
    return { result, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

// NDJSON events in order, each with its timestamp checked and dropped.
function streamEvents(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const { ts, ...event } = JSON.parse(line) as Record<string, unknown>;
      assert.match(String(ts), /^\d{4}-\d\d-\d\dT/u);
      return event;
    });
}

const savedEnv = { ...process.env };
const savedCwd = process.cwd();
beforeEach(() => {
  calls.length = 0;
  delete process.env.FORCE_COLOR;
  delete process.env.SHOP_HARNESS_BIN;
  delete process.env.SHOP_HARNESS_RUN_MODE;
  delete process.env.RECIPE_RUNTIME_DIR;
  delete process.env.RECIPE_LIBRARY_PATH;
  for (const name of [
    'RECIPE_CDP_PORT',
    'CDP_PORT',
    'TERMINAL_APP_PORT',
    'RECIPE_WATCHER_PORT',
    'WATCHER_PORT',
    'METRO_PORT',
  ])
    delete process.env[name];
  // No personal library from ~/.farmslot, and no ~/farmslot-node/pool, reaches the tests.
  process.env.FARMSLOT_HOME = tempRoot();
  process.env.HOME = tempRoot();
  (globalThis as Record<string, unknown>).__pluginImports = [];
  process.chdir(tempRoot());
});
afterEach(() => {
  process.chdir(savedCwd);
  setHarnessContext(undefined);
  configureHarnessHost(DEFAULT_HOST);
  configureHarnessAdapters(createAdapterRegistry());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('validatePublicInvocation', () => {
  function table(): ContractedCommand[] {
    return shopCommands().filter((entry): entry is PublicHarnessCommand => !entry.hidden);
  }
  beforeEach(() => {
    configureHarnessHost(shopHost());
  });

  test('accepts the bare top level, help, version and aliases', () => {
    for (const argv of [[], ['--help'], ['-h'], ['--version'], ['-v'], ['home']])
      assert.equal(validatePublicInvocation(argv, table()), null, argv.join(' '));
  });

  test('lists valid commands in table order and suggests the closest one', () => {
    const error = validatePublicInvocation(['lanch'], table());
    assert.equal(error?.code, 'CLI_UNKNOWN_COMMAND');
    assert.equal(
      error?.message,
      "unknown command 'lanch'. Valid commands: status, launch, run, call, install, update, setup, fail, crash.",
    );
    assert.equal(
      error?.userAction,
      "Did you mean 'launch' instead of 'lanch'? Try: shop-harness launch example",
    );
  });

  test('names the host for an unknown top-level option', () => {
    assert.deepEqual(validatePublicInvocation(['--verison'], table()), {
      code: 'CLI_UNKNOWN_OPTION',
      command: 'shop-harness',
      message: "unknown top-level option '--verison'. Valid top-level options: --help, --version.",
      userAction: "Did you mean '--version' instead of '--verison'? Try: shop-harness --help",
    });
  });

  test('suggests a replaced option before the nearest valid one', () => {
    const error = validatePublicInvocation(['status', '--project-root', '.'], table(), {
      replacedOptions: { '--project-root': '--target' },
    });
    assert.equal(error?.code, 'CLI_UNKNOWN_OPTION');
    assert.match(error?.userAction ?? '', /Did you mean '--target'/u);
  });

  test('tells a missing value from an invalid one, and reads function choices when validating', () => {
    assert.deepEqual(validatePublicInvocation(['launch', '--surface'], table()), {
      code: 'CLI_MISSING_OPTION_VALUE',
      command: 'launch',
      message: '--surface requires a value.',
      userAction: 'Try: shop-harness launch example. Inspect options: shop-harness launch --help',
    });
    assert.equal(
      validatePublicInvocation(['launch', '--surface', 'popup'], table())?.message,
      "--surface must be fullscreen or sidepanel; received 'popup'.",
    );
    let ids = ['web'];
    const dynamic: ContractedCommand = {
      name: 'doctor',
      example: 'shop-harness doctor',
      contract: { options: { '--adapter': valueOption(() => ids) } },
    };
    assert.equal(
      validatePublicInvocation(['doctor', '--adapter', 'plug'], [dynamic])?.code,
      'CLI_INVALID_OPTION_VALUE',
    );
    ids = ['web', 'plug'];
    assert.equal(validatePublicInvocation(['doctor', '--adapter', 'plug'], [dynamic]), null);
  });

  test('uses the command recovery for a missing positional, else the generic one', () => {
    assert.deepEqual(validatePublicInvocation(['run'], table()), {
      code: 'CLI_MISSING_POSITIONAL',
      command: 'run',
      message: 'missing required <recipe>.',
      userAction: 'List recipes: shop-harness run --list\n  Example: shop-harness run example',
    });
    assert.equal(validatePublicInvocation(['run', '--list'], table()), null);
    assert.equal(
      validatePublicInvocation(['run', '--list', 'x'], table())?.code,
      'CLI_EXCESS_POSITIONAL',
    );
    assert.equal(
      validatePublicInvocation(['run', 'smoke', 'bad'], table())?.code,
      'CLI_INVALID_POSITIONAL',
    );
    assert.equal(validatePublicInvocation(['run', 'smoke', 'market=BTC'], table()), null);
  });

  test('requires the call action before any flag, unless --list', () => {
    assert.equal(validatePublicInvocation(['call', 'ping', '--json', 'n=1'], table()), null);
    assert.equal(validatePublicInvocation(['call', '--list', '--json'], table()), null);
    const missing = {
      code: 'CLI_MISSING_POSITIONAL',
      command: 'call',
      message: 'call requires <action> first.',
      userAction: 'List actions: shop-harness call --list\n  Example: shop-harness call example',
    };
    assert.deepEqual(validatePublicInvocation(['call', '--json', 'ping'], table()), missing);
  });

  test('applies passthrough policy and the accepted positional shape', () => {
    assert.equal(
      validatePublicInvocation(['run', 'smoke', '--'], table())?.code,
      'CLI_UNEXPECTED_PASSTHROUGH',
    );
    assert.equal(validatePublicInvocation(['install', '--', '--leaf'], table()), null);
    assert.equal(
      validatePublicInvocation(['status', 'extra'], table())?.message,
      "unexpected positional 'extra'; this command accepts no positionals.",
    );
    assert.equal(
      validatePublicInvocation(['status', '--json=yes'], table())?.code,
      'CLI_INVALID_OPTION_VALUE',
    );
  });

  test('runs a command bypass and refine hook', () => {
    const checklist: ContractedCommand = {
      name: 'checklist',
      example: 'shop-harness checklist mark <dir> start',
      contract: {
        options: contractOptions(HELP, { '--share': booleanOption() }),
        positionals: [
          { label: 'action', choices: ['mark', 'closeout'] },
          { label: 'task-dir' },
          { label: 'step' },
        ],
        bypass: (tokens) => tokens[2] === 'sub',
        refine: (positionals, seen, fail) =>
          positionals[0] === 'mark' && seen.has('--share')
            ? fail.usage('CLI_UNKNOWN_OPTION', '--share is not valid with checklist mark.')
            : null,
      },
    };
    assert.equal(
      validatePublicInvocation(['checklist', 'mark', 'dir', 'sub', '--anything'], [checklist]),
      null,
    );
    assert.deepEqual(
      validatePublicInvocation(['checklist', 'mark', 'dir', '--share'], [checklist]),
      {
        code: 'CLI_UNKNOWN_OPTION',
        command: 'checklist',
        message: '--share is not valid with checklist mark.',
        userAction:
          'Try: shop-harness checklist mark <dir> start. Inspect options: shop-harness checklist --help',
      },
    );
  });

  test('reads every value an option takes before --, separate or inline', () => {
    assert.deepEqual(
      optionValues(['--library', 'a', '--library=b', 'x', '--', '--library', 'c'], '--library'),
      ['a', 'b'],
    );
  });

  test("a host explains a value an option's choices reject; a miss keeps the default", () => {
    const seen: unknown[] = [];
    const explainInvalidChoice = (choice: {
      command: string;
      option: string;
      value: string;
      tokens: readonly string[];
    }) => {
      seen.push(choice);
      return choice.value === 'kiosk'
        ? {
            code: 'SHOP_SURFACE_RETIRED',
            command: choice.command,
            message: `${choice.option} ${choice.value} moved to the kiosk library.`,
            userAction: `add the kiosk library, then rerun: shop-harness ${[choice.command, ...choice.tokens].join(' ')}`,
          }
        : null;
    };
    assert.deepEqual(
      validatePublicInvocation(['launch', '--surface', 'kiosk', '--json'], table(), {
        explainInvalidChoice,
      }),
      {
        code: 'SHOP_SURFACE_RETIRED',
        command: 'launch',
        message: '--surface kiosk moved to the kiosk library.',
        userAction: 'add the kiosk library, then rerun: shop-harness launch --surface kiosk --json',
      },
    );
    assert.deepEqual(seen, [
      {
        command: 'launch',
        option: '--surface',
        value: 'kiosk',
        tokens: ['--surface', 'kiosk', '--json'],
      },
    ]);
    // A miss is the default error, byte for byte; a valid value never asks.
    assert.deepEqual(
      validatePublicInvocation(['launch', '--surface', 'popup'], table(), { explainInvalidChoice }),
      validatePublicInvocation(['launch', '--surface', 'popup'], table()),
    );
    assert.equal(
      validatePublicInvocation(['launch', '--surface', 'fullscreen'], table(), {
        explainInvalidChoice,
      }),
      null,
    );
    assert.equal(seen.length, 2);
  });

  test('lists every name and alias for completion', () => {
    assert.deepEqual(publicCommandTokens(table()).slice(0, 3), ['status', 'home', 'launch']);
  });
});

describe('createHarnessCli', () => {
  test('prints the grouped help for no arguments and for --help', async () => {
    const cli = createHarnessCli(cliOptions());
    const bare = await capture(() => cli.main([]));
    assert.deepEqual(bare.result, { exitCode: 0, exit: 'now' });
    assert.equal(
      bare.stdout,
      [
        'shop-harness — the Shop recipe loop.',
        '',
        'DAILY — every day:',
        '  status     status summary',
        '               shop-harness status example',
        '  launch     launch summary',
        '               shop-harness launch example',
        '',
        'PROVE — run recipes:',
        '  run        run summary',
        '               shop-harness run example',
        '',
        'See README.md.',
        '',
      ].join('\n'),
    );
    const flag = await capture(() => cli.main(['--help']));
    assert.deepEqual(flag.result, { exitCode: 0, exit: 'now' });
    assert.equal(flag.stdout, bare.stdout);
  });

  test('shows the dev override and the slot the checkout is bound to', async () => {
    process.env.SHOP_HARNESS_BIN = '/dev/shop/bin/shop-harness';
    process.env.SHOP_HARNESS_RUN_MODE = 'src';
    const runtime = path.join(process.cwd(), 'temp/recipe/runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(
      path.join(runtime, 'agentic-runtime.json'),
      JSON.stringify({
        platform: 'web-extension',
        slotId: 'shop-1',
        watcherPort: 9011,
        gitBranch: 'main',
      }),
    );
    const { stdout } = await capture(() => createHarnessCli(cliOptions()).main([]));
    assert.match(
      stdout,
      /\nDEV OVERRIDE ACTIVE — this run is served by SHOP_HARNESS_BIN=\/dev\/shop\/bin\/shop-harness \(unset it to return to the installed\/global bin\)\.\nrunning from: src \(source checkout; dist shadows src when both exist\)\n/u,
    );
    assert.match(
      stdout,
      /\n\nSLOT — this checkout is a prepared slot: slot shop-1 · web-server :9011 · branch main\n/u,
    );
  });

  test('prints the host version as one line, and the recipe-cli it runs on with --verbose', async () => {
    const cli = createHarnessCli(cliOptions());
    for (const flag of ['--version', '-v']) {
      const plain = await capture(() => cli.main([flag]));
      assert.deepEqual(plain.result, { exitCode: 0, exit: 'now' });
      assert.equal(plain.stdout, '1.2.3\n');
      const verbose = await capture(() => cli.main([flag, '--verbose']));
      assert.deepEqual(verbose.result, { exitCode: 0, exit: 'now' });
      assert.equal(verbose.stdout, `1.2.3\n@farmslot/recipe-cli ${RECIPE_CLI_VERSION}\n`);
    }
    const own = createHarnessCli(
      cliOptions({ host: { ...shopHost(), packageName: '@farmslot/recipe-cli' } }),
    );
    assert.equal((await capture(() => own.main(['--version', '--verbose']))).stdout, '1.2.3\n');
  });

  test('refuses a host whose package.json is missing or has no version', () => {
    const missing = tempRoot();
    assert.throws(
      () => createHarnessCli(cliOptions({ host: { ...shopHost(), packageRoot: missing } })),
      /ENOENT/u,
    );
    const host = shopHost();
    fs.writeFileSync(path.join(host.packageRoot, 'package.json'), '{}');
    assert.throws(() => createHarnessCli(cliOptions({ host })), /package\.json has no version\./u);
  });

  test('leaves the slot line out for an unreadable context, and surfaces a slot adapter bug', async () => {
    const runtime = path.join(process.cwd(), 'temp/recipe/runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'agentic-runtime.json'), '{"slotId": "shop-');
    const torn = await capture(() => createHarnessCli(cliOptions()).main([]));
    assert.deepEqual(torn.result, { exitCode: 0, exit: 'now' });
    assert.doesNotMatch(torn.stdout, /SLOT/u);
    fs.writeFileSync(
      path.join(runtime, 'agentic-runtime.json'),
      JSON.stringify({ platform: 'web-extension', slotId: 'shop-1' }),
    );
    const options = cliOptions();
    const broken = createHarnessCli({
      ...options,
      help: {
        ...options.help,
        slotAdapter: () => {
          throw new Error('slot adapter bug');
        },
      },
    });
    await assert.rejects(
      capture(() => broken.main([])),
      /slot adapter bug/u,
    );
  });

  test('surfaces a context path it cannot read for any other reason', async () => {
    fs.mkdirSync(path.join(process.cwd(), 'temp/recipe/runtime/agentic-runtime.json'), {
      recursive: true,
    });
    await assert.rejects(
      capture(() => createHarnessCli(cliOptions()).main([])),
      /EISDIR/u,
    );
  });

  test('prints a command help text and its aliases resolve to it', async () => {
    const cli = createHarnessCli(cliOptions());
    const help = await capture(() => cli.main(['status', '--help']));
    assert.deepEqual(help.result, { exitCode: 0, exit: 'now' });
    assert.equal(help.stdout, 'shop-harness status [flags]\n\n  status help\n');
    assert.equal((await capture(() => cli.main(['home', '-h']))).stdout, help.stdout);
    assert.deepEqual(calls, []);
  });

  test('writes usage errors for people, --json and --json-stream, and exits 2 at once', async () => {
    const cli = createHarnessCli(cliOptions());
    const human = await capture(() => cli.main(['launch', 'web']));
    assert.deepEqual(human.result, { exitCode: 2, exit: 'now' });
    assert.equal(
      human.stderr,
      "✗ shop-harness launch: invalid <platform> 'web'. Valid values: ios, android.\n  Next: Try: shop-harness launch example\n",
    );
    const top = await capture(() => cli.main(['--bogus']));
    assert.match(top.stderr, /^✗ shop-harness: unknown top-level option '--bogus'\./u);

    const json = await capture(() => cli.main(['launch', '--surface', 'popup', '--json']));
    assert.equal(
      json.stdout,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          command: 'launch',
          status: 'fail',
          error: {
            code: 'CLI_INVALID_OPTION_VALUE',
            message: "--surface must be fullscreen or sidepanel; received 'popup'.",
            userAction: 'Try: shop-harness launch example',
          },
          exitCode: 2,
        },
        null,
        2,
      )}\n`,
    );
    const stream = await capture(() => cli.main(['launch', '--surface', 'popup', '--json-stream']));
    assert.deepEqual(stream.result, { exitCode: 2, exit: 'now' });
    assert.deepEqual(streamEvents(stream.stdout), [
      {
        schemaVersion: 1,
        command: 'launch',
        event: 'error',
        error: {
          code: 'CLI_INVALID_OPTION_VALUE',
          message: "--surface must be fullscreen or sidepanel; received 'popup'.",
          userAction: 'Try: shop-harness launch example',
        },
      },
      { schemaVersion: 1, command: 'launch', event: 'complete', status: 'fail', exitCode: 2 },
    ]);
    assert.equal(stream.stderr, '');
    assert.deepEqual(calls, []);
  });

  test('dispatches the arguments after the command and keeps each exit mode', async () => {
    const cli = createHarnessCli(cliOptions());
    assert.deepEqual(await cli.main(['launch', 'ios', '--json']), { exitCode: 0, exit: 'code' });
    assert.deepEqual(await cli.main(['home', '--json']), { exitCode: 0, exit: 'code' });
    assert.deepEqual(await cli.main(['update']), { exitCode: 0, exit: 'now' });
    // Hidden commands skip the public grammar and exit at once.
    assert.deepEqual(await cli.main(['runtime-probe', '--private', 'x']), {
      exitCode: 3,
      exit: 'now',
    });
    assert.deepEqual(calls, [
      { command: 'launch', argv: ['ios', '--json'] },
      { command: 'status', argv: ['--json'] },
      { command: 'update', argv: [] },
      { command: 'runtime-probe', argv: ['--private', 'x'] },
    ]);
  });

  test('maps a thrown error to its exit code, else 1', async () => {
    const cli = createHarnessCli(cliOptions());
    const usage = await capture(() => cli.main(['fail']));
    assert.deepEqual(usage.result, { exitCode: 2, exit: 'code' });
    assert.equal(usage.stderr, 'fail needs a reason.\n');
    const crash = await capture(() => cli.main(['crash']));
    assert.deepEqual(crash.result, { exitCode: 1, exit: 'code' });
    assert.equal(crash.stderr, 'crashed\n');
  });

  test('runs a raw command before the grammar, hydration and commander', async () => {
    const targets: string[] = [];
    const cli = createHarnessCli(
      cliOptions({ libraries: { hydrate: async (target) => void targets.push(target) } }),
    );
    assert.deepEqual(await cli.main(['setup', '--not-in-contract']), { exitCode: 0, exit: 'code' });
    assert.deepEqual(calls, [{ command: 'setup', argv: ['--not-in-contract'] }]);
    assert.deepEqual(targets, []);
  });

  test('hydrates libraries for the --target checkout after the grammar and before dispatch', async () => {
    const targets: string[] = [];
    const cli = createHarnessCli(
      cliOptions({
        libraries: {
          hydrate: async (target) => {
            targets.push(target);
            // Each dispatch comes after its own hydration.
            assert.equal(calls.length, targets.length - 1);
          },
        },
      }),
    );
    await capture(() => cli.main(['launch', 'web']));
    assert.deepEqual(targets, []);
    await cli.main(['status', '--target', 'shop']);
    await cli.main(['status', '--target=/abs/shop']);
    await cli.main(['status']);
    assert.deepEqual(targets, [path.resolve('shop'), '/abs/shop', process.cwd()]);
  });

  test('calls beforeDispatch once per invocation unless the command opts out', async () => {
    const seen: string[][] = [];
    const cli = createHarnessCli(
      cliOptions({ beforeDispatch: (argv) => void seen.push([...argv]) }),
    );
    await capture(() => cli.main([]));
    await cli.main(['update']);
    await cli.main(['setup']);
    await cli.main(['status']);
    await capture(() => cli.main(['nope']));
    assert.deepEqual(seen, [['status'], ['nope']]);
  });

  test('hands --help after `--` to the command itself, unjournaled and exiting at once', async () => {
    const cli = createHarnessCli(cliOptions());
    assert.deepEqual(await cli.main(['install', '--', '--help']), { exitCode: 0, exit: 'now' });
    assert.deepEqual(calls, [{ command: 'install', argv: ['--', '--help'] }]);
  });

  test('renders call <action> --help through the catalog, mapping its usage errors', async () => {
    const withoutCatalog = await capture(() =>
      createHarnessCli(cliOptions()).main(['call', 'x', '--help']),
    );
    assert.equal(withoutCatalog.stdout, 'shop-harness call [flags]\n\n  call help\n');
    // A catalog that can't resolve the action's manifest degrades to the generic help.
    const catalog = {} as NonNullable<HarnessCliOptions['catalog']>;
    const cli = createHarnessCli(cliOptions({ catalog }));
    const degraded = await capture(() => cli.main(['call', 'x', 'k=v', '--help']));
    assert.deepEqual(degraded.result, { exitCode: 0, exit: 'now' });
    assert.match(degraded.stdout, /call help/u);
    const { result, stderr } = await capture(() => cli.main(['call', 'x', '--slot', '--help']));
    assert.deepEqual(result, { exitCode: 2, exit: 'now' });
    assert.equal(stderr, 'Missing value for --slot\n');
  });

  test('renders a call action from the catalog above the generic call help', async () => {
    const library = tempRoot();
    fs.mkdirSync(path.join(library, 'recipes'));
    const manifest = JSON.parse(
      fs.readFileSync(new URL('./fixtures/proof.action-manifest.json', import.meta.url), 'utf8'),
    ) as Awaited<ReturnType<RecipeCatalog['resolveActionManifest']>>['manifest'];
    const catalog: RecipeCatalog = {
      bundledLibrary: { name: 'shop', root: library, actionNamespace: 'shop' },
      resolveActionManifest: async () => ({ manifest, actionSources: new Map() }),
      validateManifest: async () => undefined,
      actionCapabilities: () => [],
    };
    const call = command('call', {
      options: contractOptions(HELP, JSON_FLAG, TARGET, { '--adapter': valueOption(['web']) }),
      positionals: [{ label: 'action' }],
    });
    const cli = createHarnessCli({
      ...cliOptions({ catalog }),
      commands: [...shopCommands().filter((entry) => entry.name !== 'call'), call],
    });
    const { result, stdout } = await capture(() =>
      cli.main(['call', 'switch', '--help', '--adapter', 'web', '--target', process.cwd()]),
    );
    assert.deepEqual(result, { exitCode: 0, exit: 'now' });
    const value = stdout.search(/\n +value +string \(required\)/u);
    const equals = stdout.search(/\n +equals +string \(required\)/u);
    const generic = stdout.indexOf('shop-harness call [flags]\n\n  call help\n');
    assert.ok(value > 0 && equals > 0, stdout);
    assert.ok(generic > Math.max(value, equals), stdout);
    assert.deepEqual(calls, []);
  });

  test("renders the action of the checkout's detected adapter without --adapter", async () => {
    const library = tempRoot();
    fs.mkdirSync(path.join(library, 'recipes'));
    const manifest = JSON.parse(
      fs.readFileSync(new URL('./fixtures/proof.action-manifest.json', import.meta.url), 'utf8'),
    ) as Awaited<ReturnType<RecipeCatalog['resolveActionManifest']>>['manifest'];
    const catalog: RecipeCatalog = {
      bundledLibrary: { name: 'shop', root: library, actionNamespace: 'shop' },
      resolveActionManifest: async () => ({ manifest, actionSources: new Map() }),
      validateManifest: async () => undefined,
      actionCapabilities: () => [],
    };
    const call = command('call', {
      options: contractOptions(HELP, JSON_FLAG, TARGET, { '--adapter': valueOption(['web']) }),
      positionals: [{ label: 'action' }],
    });
    const registry = createAdapterRegistry();
    registry.register({ ...fakeAdapter('web'), detect: { files: () => true } });
    const cli = createHarnessCli({
      ...cliOptions({ catalog, adapters: registry }),
      commands: [...shopCommands().filter((entry) => entry.name !== 'call'), call],
    });
    const { result, stdout } = await capture(() => cli.main(['call', 'switch', '--help']));
    assert.deepEqual(result, { exitCode: 0, exit: 'now' });
    const value = stdout.search(/\n +value +string \(required\)/u);
    const equals = stdout.search(/\n +equals +string \(required\)/u);
    const generic = stdout.indexOf('shop-harness call [flags]\n\n  call help\n');
    assert.ok(value > 0 && equals > 0, stdout);
    assert.ok(generic > Math.max(value, equals), stdout);
    assert.deepEqual(calls, []);
  });

  test('configures the host and adapters it is given', async () => {
    const options = cliOptions();
    createHarnessCli(options);
    assert.equal(harnessHost().name, 'shop-harness');
    assert.deepEqual(options.adapters.list(), ['web']);
  });
});

describe('library-declared adapters', () => {
  // A library whose recipe-library.json declares `id`, implemented by a module
  // that records its import.
  function pluginLibrary(id: string, sdkVersion = ADAPTER_SDK_VERSION): string {
    const root = fs.realpathSync(tempRoot());
    fs.mkdirSync(path.join(root, 'plugins'));
    fs.writeFileSync(
      path.join(root, 'plugins', `${id}.mjs`),
      `globalThis.__pluginImports.push('${id}');
export const adapter = {
  id: '${id}', sdkVersion: ${sdkVersion}, headless: true, resolveSlotPorts() {},
  async runtimeStatus() { return { decision: 'ready', reasons: [] }; },
  devServer: { label: 'none', describe: () => 'none', stop: () => ({ kind: 'none' }) },
  logSources: () => [], appLogSource: () => null,
  hints: { launch: 'l', relaunch: 'l', runtimeProbeRecovery: () => 'd' },
  actions: { manifestPath: () => '/m.json', semantic: [], cdpTarget: { transport: 'none', probePath: '/' } },
  harness: { install: { entry: 'i', fallback: 'i' }, cleanup: { entry: 'c', fallback: 'c' }, verify: () => ({ error: 'none' }) },
  runtimeContext: { forbiddenFields: [] },
  async launch() { return 0; },
};
`,
    );
    fs.writeFileSync(
      path.join(root, 'recipe-library.json'),
      JSON.stringify({ adapters: { [id]: { module: `./plugins/${id}.mjs`, export: 'adapter' } } }),
    );
    return root;
  }
  const imported = (): string[] =>
    (globalThis as Record<string, unknown>).__pluginImports as string[];
  function pluginOptions(): HarnessCliOptions {
    const doctor = command('doctor', {
      options: contractOptions(HELP, JSON_FLAG, {
        '--adapter': valueOption((tokens) => adapterChoices(optionValues(tokens, '--library'))),
        '--library': valueOption(),
      }),
    });
    return cliOptions({ commands: [...shopCommands(), doctor] });
  }

  test('imports a declared adapter only when the command selects it', async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('plug')}`;
    const cli = createHarnessCli(pluginOptions());
    assert.deepEqual(await cli.main(['doctor']), { exitCode: 0, exit: 'code' });
    assert.deepEqual(imported(), []);
    assert.deepEqual(await cli.main(['doctor', '--adapter', 'plug']), {
      exitCode: 0,
      exit: 'code',
    });
    assert.deepEqual(imported(), ['plug']);
    assert.equal(harnessAdapters().has('plug'), true);
  });

  test('accepts a --library adapter in the grammar and loads it from that library', async () => {
    const root = pluginLibrary('flagged');
    const cli = createHarnessCli(pluginOptions());
    const refused = await capture(() => cli.main(['doctor', '--adapter', 'flagged']));
    assert.equal(refused.result.exitCode, 2);
    assert.match(refused.stderr, /--adapter must be web; received 'flagged'\./u);
    assert.deepEqual(await cli.main(['doctor', '--adapter=flagged', '--library', `lib=${root}`]), {
      exitCode: 0,
      exit: 'code',
    });
    assert.deepEqual(imported(), ['flagged']);
    const inline = pluginLibrary('inline');
    assert.deepEqual(
      await cli.main(['doctor', '--adapter', 'inline', `--library=lib2=${inline}`]),
      {
        exitCode: 0,
        exit: 'code',
      },
    );
    assert.deepEqual(imported(), ['flagged', 'inline']);
  });

  test('loads an adapter from a library only the host configures', async () => {
    const configured = [{ name: 'cfg', root: pluginLibrary('kept') }];
    const options = pluginOptions();
    const cli = createHarnessCli({
      ...options,
      commands: [
        ...shopCommands(),
        command('doctor', {
          options: contractOptions(HELP, JSON_FLAG, {
            '--adapter': valueOption((tokens) =>
              adapterChoices(optionValues(tokens, '--library'), { configured }),
            ),
          }),
        }),
      ],
      configuredLibraries: () => configured,
    });
    assert.deepEqual(await cli.main(['doctor', '--adapter', 'kept']), {
      exitCode: 0,
      exit: 'code',
    });
    assert.deepEqual(imported(), ['kept']);
    assert.equal(harnessAdapters().has('kept'), true);
  });

  test('loads the adapter the last --adapter selects, as the commands resolve it', async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('late')}`;
    const cli = createHarnessCli(pluginOptions());
    await cli.main(['doctor', '--adapter', 'late', '--adapter', 'web']);
    assert.deepEqual(imported(), []);
    await cli.main(['doctor', '--adapter', 'web', '--adapter', 'late']);
    assert.deepEqual(imported(), ['late']);
  });

  test('loads the selected adapter before call <action> --help renders', async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('helped')}`;
    const call = command('call', {
      options: contractOptions(HELP, JSON_FLAG, {
        '--adapter': valueOption((tokens) => adapterChoices(optionValues(tokens, '--library'))),
        '--slot': optionalValueOption(),
      }),
      positionals: [{ label: 'action' }],
    });
    const cli = createHarnessCli({
      ...pluginOptions(),
      commands: [...shopCommands().filter((entry) => entry.name !== 'call'), call],
      catalog: {} as NonNullable<HarnessCliOptions['catalog']>,
    });
    // --slot with no value stops the action help early, after the load.
    const { result } = await capture(() =>
      cli.main(['call', 'x', '--adapter', 'helped', '--slot', '--help']),
    );
    assert.deepEqual(result, { exitCode: 2, exit: 'now' });
    assert.deepEqual(imported(), ['helped']);
  });

  test('never loads a plugin from a library only hydration adds, hidden commands included', async () => {
    const root = pluginLibrary('found');
    const cli = createHarnessCli({
      ...pluginOptions(),
      libraries: {
        hydrate: async () => {
          process.env.RECIPE_LIBRARY_PATH = `found=${root}`;
        },
      },
    });
    assert.deepEqual(await cli.main(['runtime-probe', '--adapter', 'found']), {
      exitCode: 3,
      exit: 'now',
    });
    assert.deepEqual(imported(), []);
    assert.equal(harnessAdapters().has('found'), false);
  });

  test('prints a refused adapter with its code and next step', async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('old', 99)}`;
    const cli = createHarnessCli(pluginOptions());
    const human = await capture(() => cli.main(['doctor', '--adapter', 'old']));
    assert.deepEqual(human.result, { exitCode: 2, exit: 'now' });
    assert.match(
      human.stderr,
      /^✗ shop-harness doctor: adapter 'old' targets adapter SDK 99; shop-harness implements \d+\.\n {2}Next: /u,
    );
    const json = await capture(() => cli.main(['doctor', '--adapter', 'old', '--json']));
    const envelope = JSON.parse(json.stdout) as { error: { code: string } };
    assert.equal(envelope.error.code, 'ADAPTER_SDK_UNSUPPORTED');
    const stream = await capture(() => cli.main(['doctor', '--adapter', 'old', '--json-stream']));
    assert.deepEqual(stream.result, { exitCode: 2, exit: 'now' });
    assert.equal(stream.stderr, '');
    const events = streamEvents(stream.stdout);
    assert.deepEqual(
      events.map(({ event, status, exitCode }) => ({ event, status, exitCode })),
      [
        { event: 'error', status: undefined, exitCode: undefined },
        { event: 'complete', status: 'fail', exitCode: 2 },
      ],
    );
    assert.deepEqual(events[0]?.error, envelope.error);
    assert.equal(harnessAdapters().has('old'), false);
    assert.deepEqual(calls, []);
  });

  test('runs a built-in beside a library entry that does not parse; refuses a plugin there', async () => {
    process.env.RECIPE_LIBRARY_PATH = '=foo';
    const cli = createHarnessCli(pluginOptions());
    assert.deepEqual(await cli.main(['doctor', '--adapter', 'web', '--json']), {
      exitCode: 0,
      exit: 'code',
    });
    assert.deepEqual(calls, [{ command: 'doctor', argv: ['--adapter', 'web', '--json'] }]);
    const root = pluginLibrary('plug');
    const plugin = await capture(() =>
      cli.main(['doctor', '--adapter', 'plug', '--library', `plugs=${root}`, '--json']),
    );
    assert.deepEqual(plugin.result, { exitCode: 2, exit: 'now' });
    const envelope = JSON.parse(plugin.stdout) as { error: { code: string } };
    assert.equal(envelope.error.code, 'RECIPE_LIBRARY_PATH_INVALID');
    assert.deepEqual(imported(), []);
  });

  test('prints a library path or manifest refusal in human, --json and --json-stream form', async () => {
    const broken = fs.realpathSync(tempRoot());
    fs.writeFileSync(
      path.join(broken, 'recipe-library.json'),
      JSON.stringify({ adapters: { broken: { module: '' } } }),
    );
    const cases = [
      {
        code: 'RECIPE_LIBRARY_PATH_INVALID',
        env: '=foo',
        argv: ['doctor', '--adapter', 'plug', '--library', `plugs=${pluginLibrary('plug')}`],
        message:
          /^✗ shop-harness doctor: Recipe library entry "=foo" must be name=path or path\.\n {2}Next: /u,
      },
      {
        code: 'RECIPE_LIBRARY_MANIFEST_INVALID',
        env: `bad=${broken}`,
        argv: ['doctor', '--adapter', 'broken'],
        message: /^✗ shop-harness doctor: .*adapters\.broken\.module must be a path\.\n {2}Next: /u,
      },
    ];
    for (const { code, env, argv, message } of cases) {
      process.env.RECIPE_LIBRARY_PATH = env;
      const cli = createHarnessCli(pluginOptions());
      const human = await capture(() => cli.main(argv));
      assert.deepEqual(human.result, { exitCode: 2, exit: 'now' }, code);
      assert.match(human.stderr, message, code);
      const json = await capture(() => cli.main([...argv, '--json']));
      assert.deepEqual(json.result, { exitCode: 2, exit: 'now' }, code);
      const envelope = JSON.parse(json.stdout) as { error: Record<string, unknown> };
      assert.equal(envelope.error.code, code);
      const stream = await capture(() => cli.main([...argv, '--json-stream']));
      assert.deepEqual(stream.result, { exitCode: 2, exit: 'now' }, code);
      assert.equal(stream.stderr, '', code);
      const events = streamEvents(stream.stdout);
      assert.deepEqual(
        events.map(({ event, status, exitCode }) => ({ event, status, exitCode })),
        [
          { event: 'error', status: undefined, exitCode: undefined },
          { event: 'complete', status: 'fail', exitCode: 2 },
        ],
        code,
      );
      assert.deepEqual(events[0]?.error, envelope.error, code);
    }
    assert.deepEqual(imported(), []);
    assert.deepEqual(calls, []);
  });

  test('runs afterAdapterLoad once the selected adapter is loaded, before any help or dispatch', async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('hooked')}`;
    const loaded: Array<{ id: string; recorded: boolean; calls: number }> = [];
    const call = command('call', {
      options: contractOptions(HELP, JSON_FLAG, {
        '--adapter': valueOption((tokens) => adapterChoices(optionValues(tokens, '--library'))),
        '--note': optionalValueOption(),
      }),
      positionals: [{ label: 'action' }],
      allowPassthrough: true,
    });
    const options = pluginOptions();
    const cli = createHarnessCli({
      ...options,
      commands: [...options.commands.filter((entry) => entry.name !== 'call'), call],
      catalog: {} as NonNullable<HarnessCliOptions['catalog']>,
      afterAdapterLoad: async (id) => {
        loaded.push({ id, recorded: adapterPlugin(id) !== undefined, calls: calls.length });
      },
    });
    await cli.main(['doctor']);
    assert.deepEqual(loaded, []);
    await cli.main(['doctor', '--adapter', 'hooked']);
    await cli.main(['doctor', '--adapter', 'web']);
    await capture(() => cli.main(['call', 'x', '--adapter', 'hooked', '--note', '--help']));
    await cli.main(['call', 'x', '--adapter', 'hooked', '--', '--help']);
    // `calls` counts dispatches so far: the hook runs before each command's own.
    assert.deepEqual(loaded, [
      { id: 'hooked', recorded: true, calls: 1 },
      { id: 'web', recorded: false, calls: 2 },
      { id: 'hooked', recorded: true, calls: 3 },
      { id: 'hooked', recorded: true, calls: 3 },
    ]);
    assert.deepEqual(
      calls.map((entry) => entry.command),
      ['doctor', 'doctor', 'doctor', 'call'],
    );
  });

  test("prints afterAdapterLoad's refusal like the loader's; leaves any other error to the mapper", async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('fenced')}`;
    const refusing = createHarnessCli({
      ...pluginOptions(),
      // An async hook: its rejection is the refusal.
      afterAdapterLoad: async () => {
        throw new AdapterPluginError(
          'ADAPTER_PLUGIN_INVALID',
          "adapter 'fenced' policy imports a file its digest misses.",
          'keep the policy beside the plugin module',
        );
      },
    });
    const argv = ['doctor', '--adapter', 'fenced'];
    const human = await capture(() => refusing.main(argv));
    assert.deepEqual(human.result, { exitCode: 2, exit: 'now' });
    assert.equal(
      human.stderr,
      "✗ shop-harness doctor: adapter 'fenced' policy imports a file its digest misses.\n  Next: keep the policy beside the plugin module\n",
    );
    const json = await capture(() => refusing.main([...argv, '--json']));
    assert.deepEqual(json.result, { exitCode: 2, exit: 'now' });
    const envelope = JSON.parse(json.stdout) as { error: Record<string, unknown> };
    assert.deepEqual(envelope.error, {
      code: 'ADAPTER_PLUGIN_INVALID',
      message: "adapter 'fenced' policy imports a file its digest misses.",
      userAction: 'keep the policy beside the plugin module',
    });
    const stream = await capture(() => refusing.main([...argv, '--json-stream']));
    assert.deepEqual(stream.result, { exitCode: 2, exit: 'now' });
    assert.deepEqual(
      streamEvents(stream.stdout).map(({ event, error, status, exitCode }) => ({
        event,
        error,
        status,
        exitCode,
      })),
      [
        { event: 'error', error: envelope.error, status: undefined, exitCode: undefined },
        { event: 'complete', error: undefined, status: 'fail', exitCode: 2 },
      ],
    );
    const crashing = createHarnessCli({
      ...pluginOptions(),
      afterAdapterLoad: () => {
        throw new Error('hook crashed');
      },
    });
    const crash = await capture(() => crashing.main(argv));
    assert.deepEqual(crash.result, { exitCode: 1, exit: 'now' });
    assert.equal(crash.stderr, 'hook crashed\n');
    assert.deepEqual(calls, []);
  });

  test("afterAdapterLoad's refusal ends every help path before it prints", async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('fenced')}`;
    const ran: string[] = [];
    const call = command('call', {
      options: contractOptions(HELP, JSON_FLAG, {
        '--adapter': valueOption((tokens) => adapterChoices(optionValues(tokens, '--library'))),
      }),
      positionals: [{ label: 'action' }],
      allowPassthrough: true,
    });
    const options = pluginOptions();
    const cli = createHarnessCli({
      ...options,
      commands: [...options.commands.filter((entry) => entry.name !== 'call'), call],
      catalog: {} as NonNullable<HarnessCliOptions['catalog']>,
      afterAdapterLoad: (id) => {
        ran.push(id);
        throw new AdapterPluginError('ADAPTER_PLUGIN_INVALID', 'policy is unfenced.', 'fence it');
      },
    });
    for (const argv of [
      ['call', 'x', '--help', '--adapter', 'fenced'],
      ['call', 'x', '--adapter', 'fenced', '--', '--help'],
      ['doctor', '--help', '--adapter', 'fenced'],
    ]) {
      const out = await capture(() => cli.main(argv));
      assert.deepEqual(out.result, { exitCode: 2, exit: 'now' }, argv.join(' '));
      assert.equal(out.stdout, '', argv.join(' '));
      assert.equal(
        out.stderr,
        `✗ shop-harness ${argv[0]}: policy is unfenced.\n  Next: fence it\n`,
        argv.join(' '),
      );
    }
    assert.deepEqual(ran, ['fenced', 'fenced', 'fenced']);
    assert.deepEqual(calls, []);
  });

  test("passes the host's explanation of a rejected choice through the grammar", async () => {
    const cli = createHarnessCli({
      ...pluginOptions(),
      explainInvalidChoice: ({ command, option, value }) =>
        value === 'kiosk'
          ? {
              code: 'SHOP_ADAPTER_LIBRARY_MISSING',
              command,
              message: `${option} ${value} needs the kiosk library.`,
              userAction: 'add the kiosk library to RECIPE_LIBRARY_PATH',
            }
          : null,
    });
    const human = await capture(() => cli.main(['doctor', '--adapter', 'kiosk']));
    assert.deepEqual(human.result, { exitCode: 2, exit: 'now' });
    assert.equal(
      human.stderr,
      '✗ shop-harness doctor: --adapter kiosk needs the kiosk library.\n  Next: add the kiosk library to RECIPE_LIBRARY_PATH\n',
    );
    const json = await capture(() => cli.main(['doctor', '--adapter', 'kiosk', '--json']));
    assert.equal(
      (JSON.parse(json.stdout) as { error: { code: string } }).error.code,
      'SHOP_ADAPTER_LIBRARY_MISSING',
    );
    const typo = await capture(() => cli.main(['doctor', '--adapter', 'wbe', '--json']));
    assert.equal(
      (JSON.parse(typo.stdout) as { error: { code: string } }).error.code,
      'CLI_INVALID_OPTION_VALUE',
    );
    assert.deepEqual(calls, []);
  });

  test("prints the fence's refusal of a plugin's import the same way", async () => {
    const root = pluginLibrary('leaky');
    const module = path.join(root, 'plugins', 'leaky.mjs');
    fs.writeFileSync(path.join(root, 'outside.mjs'), 'export const x = 1;\n');
    fs.writeFileSync(module, `import '../outside.mjs';\n${fs.readFileSync(module, 'utf8')}`);
    process.env.RECIPE_LIBRARY_PATH = `plugs=${root}`;
    const json = await capture(() =>
      createHarnessCli(pluginOptions()).main(['doctor', '--adapter', 'leaky', '--json']),
    );
    assert.deepEqual(json.result, { exitCode: 2, exit: 'now' });
    const envelope = JSON.parse(json.stdout) as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, 'RECIPE_SOURCE_INVALID');
    assert.match(
      envelope.error.message,
      /adapter 'leaky' \(library plugs\) imports \.\.\/outside\.mjs/u,
    );
  });

  test("leaves an error from the host's adopt to the error mapper", async () => {
    process.env.RECIPE_LIBRARY_PATH = `plugs=${pluginLibrary('adopted')}`;
    const cli = createHarnessCli({
      ...pluginOptions(),
      adopt: () => {
        throw Object.assign(new Error('host adopt failed'), {
          code: 'HOST_OWN',
          userAction: 'not a refusal',
        });
      },
    });
    const { result, stdout, stderr } = await capture(() =>
      cli.main(['doctor', '--adapter', 'adopted', '--json']),
    );
    assert.deepEqual(result, { exitCode: 1, exit: 'now' });
    assert.equal(stdout, '');
    assert.equal(stderr, 'host adopt failed\n');
  });
});

describe('invocation context', () => {
  // A library whose plugins declare `detect`; each module records its import.
  function detectingLibrary(plugins: Record<string, Record<string, string[]>>): string {
    const root = fs.realpathSync(tempRoot());
    fs.mkdirSync(path.join(root, 'plugins'));
    const declared: Record<string, unknown> = {};
    for (const [id, detect] of Object.entries(plugins)) {
      fs.writeFileSync(
        path.join(root, 'plugins', `${id}.mjs`),
        `globalThis.__pluginImports.push('${id}');
export const adapter = {
  id: '${id}', sdkVersion: ${ADAPTER_SDK_VERSION}, headless: true, resolveSlotPorts() {},
  async runtimeStatus() { return { decision: 'ready', reasons: [] }; },
  devServer: { label: 'none', describe: () => 'none', stop: () => ({ kind: 'none' }) },
  logSources: () => [], appLogSource: () => null,
  hints: { launch: 'l', relaunch: 'l', runtimeProbeRecovery: () => 'd' },
  actions: { manifestPath: () => '/m.json', semantic: [], cdpTarget: { transport: 'none', probePath: '/' } },
  harness: { install: { entry: 'i', fallback: 'i' }, cleanup: { entry: 'c', fallback: 'c' }, verify: () => ({ error: 'none' }) },
  runtimeContext: { forbiddenFields: [] },
  async launch() { return 0; },
};
`,
      );
      declared[id] = { module: `./plugins/${id}.mjs`, export: 'adapter', detect };
    }
    fs.writeFileSync(
      path.join(root, 'recipe-library.json'),
      JSON.stringify({ adapters: declared }),
    );
    return root;
  }
  const imported = (): string[] =>
    (globalThis as Record<string, unknown>).__pluginImports as string[];

  // A checkout both plugins match: `terminal` by remote and files, `shop` by files.
  function terminalCheckout(): string {
    const checkout = fs.realpathSync(tempRoot());
    fs.writeFileSync(path.join(checkout, 'package.json'), '{"dependencies":{"next":"15"}}');
    execFileSync('git', ['-C', checkout, 'init', '-q'], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-C', checkout, 'remote', 'add', 'origin', 'git@x:acme/va-mmcx-terminal'],
      {
        stdio: 'ignore',
      },
    );
    return checkout;
  }

  function contextOptions(seen: (string | undefined)[]): HarnessCliOptions {
    const status = command(
      'status',
      {
        options: contractOptions(HELP, JSON_FLAG, TARGET, {
          '--adapter': valueOption((tokens) => adapterChoices(optionValues(tokens, '--library'))),
          '--task': optionalValueOption(),
          '--watch': booleanOption(),
        }),
      },
      {
        run: () => {
          seen.push(contextAdapter(process.cwd()));
          calls.push({ command: 'status', argv: [] });
          return 0;
        },
      },
    );
    const base = cliOptions();
    return {
      ...base,
      commands: [...base.commands.filter((entry) => entry.name !== 'status'), status],
    };
  }

  test('loads, adopts and fences only the winning plugin, and the command acts on it', async () => {
    const checkout = terminalCheckout();
    process.chdir(checkout);
    process.env.RECIPE_LIBRARY_PATH = `terms=${detectingLibrary({
      terminal: { remote: ['va-mmcx-terminal'], packageDependencies: ['next'] },
      shop: { packageDependencies: ['next'] },
    })}`;
    const seen: (string | undefined)[] = [];
    const adopted: string[] = [];
    const fenced: string[] = [];
    const cli = createHarnessCli({
      ...contextOptions(seen),
      adopt: (adapter) => {
        adopted.push(adapter.id);
        return adapter;
      },
      afterAdapterLoad: (id) => {
        fenced.push(id);
      },
    });
    const { result, stdout, stderr } = await capture(() => cli.main(['status']));
    assert.deepEqual(result, { exitCode: 0, exit: 'code' });
    // The losing candidate is never imported, adopted, registered or fenced.
    assert.deepEqual(imported(), ['terminal']);
    assert.deepEqual(adopted, ['terminal']);
    assert.deepEqual(fenced, ['terminal']);
    assert.equal(harnessAdapters().has('shop'), false);
    assert.deepEqual(seen, ['terminal']);
    assert.equal(stdout, '');
    assert.equal(
      stderr,
      `context: adapter terminal (detected: remote+files), target ${checkout} (cwd), slot unknown (no pool dir)\n`,
    );
    assert.equal(harnessContext()?.adapter?.library, 'terms');

    // --json keeps stderr clean; a typed --adapter needs no context line.
    const json = await capture(() => cli.main(['status', '--json']));
    assert.equal(json.stderr, '');
    const flagged = await capture(() => cli.main(['status', '--adapter', 'web']));
    assert.equal(flagged.stderr, '');
    // The flag is the context too, so the command reads it.
    assert.deepEqual(seen, ['terminal', 'terminal', 'web']);
  });

  test('stops an ambiguous checkout with exit 2 and the candidates, in every output form', async () => {
    const checkout = terminalCheckout();
    process.chdir(checkout);
    process.env.RECIPE_LIBRARY_PATH = `terms=${detectingLibrary({
      terminal: { packageDependencies: ['next'] },
      shop: { packageDependencies: ['next'] },
    })}`;
    const cli = createHarnessCli(contextOptions([]));
    const candidates = [
      { adapter: 'terminal', matched: ['files'], library: 'terms' },
      { adapter: 'shop', matched: ['files'], library: 'terms' },
    ];
    const message = `${checkout} matches more than one adapter: terminal (files), shop (files)`;
    const human = await capture(() => cli.main(['status']));
    assert.deepEqual(human.result, { exitCode: 2, exit: 'now' });
    assert.equal(
      human.stderr,
      `✗ shop-harness status: ${message}\n  Next: pass --adapter <terminal|shop>\n`,
    );
    const json = await capture(() => cli.main(['status', '--json']));
    assert.deepEqual(json.result, { exitCode: 2, exit: 'now' });
    assert.deepEqual((JSON.parse(json.stdout) as { error: unknown }).error, {
      code: 'ADAPTER_AMBIGUOUS',
      message,
      userAction: 'pass --adapter <terminal|shop>',
      candidates,
    });
    const stream = await capture(() => cli.main(['status', '--json-stream']));
    assert.deepEqual(stream.result, { exitCode: 2, exit: 'now' });
    assert.deepEqual(streamEvents(stream.stdout)[0]?.error, {
      code: 'ADAPTER_AMBIGUOUS',
      message,
      userAction: 'pass --adapter <terminal|shop>',
      candidates,
    });
    assert.deepEqual(imported(), []);
    assert.deepEqual(calls, []);

    // A flag settles it; help resolves leniently, so a tie never refuses it.
    const flagged = await capture(() => cli.main(['status', '--adapter', 'shop']));
    assert.deepEqual(flagged.result, { exitCode: 0, exit: 'code' });
    assert.deepEqual(imported(), ['shop']);
    const help = await capture(() => cli.main(['status', '--help']));
    assert.equal(help.result.exitCode, 0);
  });

  test('slot ambiguity is a structured refusal before dispatch, while help stays readable', async () => {
    const checkout = terminalCheckout();
    process.chdir(checkout);
    const pools = fs.realpathSync(tempRoot());
    fs.writeFileSync(
      path.join(pools, 'local.json'),
      JSON.stringify({
        host: 'localhost',
        slots: [
          { id: 'one', repo: checkout },
          { id: 'two', repo: checkout },
        ],
      }),
    );
    const cli = createHarnessCli({
      ...contextOptions([]),
      slotPoolDir: () => pools,
    });
    const refused = await capture(() => cli.main(['status', '--json']));
    assert.equal(refused.result.exitCode, 2);
    assert.equal(JSON.parse(refused.stdout).error.code, 'SLOT_AMBIGUOUS');
    assert.match(JSON.parse(refused.stdout).error.userAction, /single pool slot/u);
    assert.deepEqual(JSON.parse(refused.stdout).error.candidates, ['one', 'two']);
    assert.deepEqual(calls, []);
    const help = await capture(() => cli.main(['status', '--help']));
    assert.equal(help.result.exitCode, 0);
    assert.match(help.stdout, /status help/u);
  });

  test('legacy provisioning slot identities reach the handler without requiring a pool entry', async () => {
    const checkout = fs.realpathSync(tempRoot());
    const pools = fs.realpathSync(tempRoot());
    fs.writeFileSync(
      path.join(pools, 'local.json'),
      JSON.stringify({
        host: 'localhost',
        slots: [{ id: 'registered', repo: checkout }],
      }),
    );
    const cli = createHarnessCli({
      ...cliOptions(),
      slotPoolDir: () => pools,
      commands: [
        command('provision', {
          options: contractOptions(HELP, {
            '--adapter': valueOption(),
            '--slot': valueOption(),
            '--target': valueOption(),
            '--runtime-dir': valueOption(),
          }),
          positionals: [{ label: 'mode' }, { label: 'platform' }],
        }),
      ],
    });
    const argv = [
      'runway',
      'ios',
      '--adapter',
      'web',
      '--slot',
      'scratch-1',
      '--runtime-dir',
      'temp/recipe/runtime-8081',
      '--target',
      checkout,
    ];
    const result = await capture(() => cli.main(['provision', ...argv]));
    assert.equal(result.result.exitCode, 0, result.stderr);
    assert.deepEqual(calls, [{ command: 'provision', argv }]);
  });

  test('status --task and --watch resolve the target and slot only, so an ambiguous checkout is fine', async () => {
    const checkout = terminalCheckout();
    process.chdir(checkout);
    process.env.RECIPE_LIBRARY_PATH = `terms=${detectingLibrary({
      terminal: { packageDependencies: ['next'] },
      shop: { packageDependencies: ['next'] },
    })}`;
    const cli = createHarnessCli(contextOptions([]));
    for (const argv of [
      ['status', '--task', '--json'],
      ['status', '--task=dir', '--json'],
      ['status', '--watch'],
    ]) {
      const { result, stderr } = await capture(() => cli.main(argv));
      assert.deepEqual(result, { exitCode: 0, exit: 'code' }, argv.join(' '));
      assert.equal(stderr, '');
      assert.deepEqual(harnessContext(), {
        target: { value: checkout, source: 'default', detail: 'cwd' },
        slot: { value: null, source: 'none', detail: 'no-pool-dir' },
      });
    }
    assert.deepEqual(imported(), []);
  });

  test('a command that detects a target itself refuses an ambiguous one with the candidates', async () => {
    const checkout = fs.realpathSync(tempRoot());
    fs.writeFileSync(path.join(checkout, 'shop.json'), '{}');
    const registry = createAdapterRegistry();
    registry.register({ ...fakeAdapter('web'), detect: { files: () => true } });
    registry.register({ ...fakeAdapter('cafe'), detect: { files: () => true } });
    const check = command(
      'check',
      { options: contractOptions(HELP, JSON_FLAG), positionals: [{ label: 'dir' }] },
      { run: (argv) => (detectAdapter(argv[0] ?? '') ? 0 : 1) },
    );
    const cli = createHarnessCli({ ...cliOptions({ adapters: registry }), commands: [check] });
    const candidates = [
      { adapter: 'web', matched: ['files'] },
      { adapter: 'cafe', matched: ['files'] },
    ];
    const json = await capture(() => cli.main(['check', checkout, '--json']));
    assert.equal(json.result.exitCode, 2);
    assert.deepEqual(
      (JSON.parse(json.stdout) as { error: { candidates: unknown } }).error.candidates,
      candidates,
    );
    const human = await capture(() => cli.main(['check', checkout]));
    assert.equal(human.result.exitCode, 2);
    assert.match(
      human.stderr,
      /matches more than one adapter: web \(files\), cafe \(files\)\n {2}Next: pass --adapter <web\|cafe>/u,
    );
  });

  test("fills the slot's ports through the environment, never the argv the command gets", async () => {
    const checkout = fs.realpathSync(tempRoot());
    const pools = fs.realpathSync(tempRoot());
    fs.writeFileSync(
      path.join(pools, 'macwork.json'),
      JSON.stringify({
        machine: 'macwork',
        host: 'localhost',
        slots: [
          {
            id: 'macwork-mmt-1',
            repo: checkout,
            session: 'mmt-1',
            resources: {
              'dev-server': { port: 9341, metro_port: 9441 },
              browser: { cdp_port: 9541 },
            },
          },
        ],
      }),
    );
    process.env.FARMSLOT_POOL_DIR = pools;
    process.chdir(checkout);
    const PORT_NAMES = [
      'RECIPE_CDP_PORT',
      'CDP_PORT',
      'RECIPE_WATCHER_PORT',
      'WATCHER_PORT',
      'METRO_PORT',
    ];
    const received: { argv: string[]; env: Record<string, string | undefined> }[] = [];
    const record = (argv: string[]) => {
      received.push({
        argv,
        env: Object.fromEntries(PORT_NAMES.map((name) => [name, process.env[name]])),
      });
      return 0;
    };
    const portOptions = {
      '--adapter': valueOption(),
      '--cdp-port': valueOption(),
      '--watcher-port': valueOption(),
      '--port': valueOption(),
    };
    const doctor = command(
      'doctor',
      { options: contractOptions(HELP, JSON_FLAG, TARGET, portOptions), allowPassthrough: true },
      { run: record },
    );
    const install = command(
      'install',
      { options: contractOptions(HELP, TARGET, portOptions), allowPassthrough: true },
      { run: record },
    );
    const cli = createHarnessCli({
      ...cliOptions({ host: { ...shopHost(), journaledCommands: ['doctor'] } }),
      commands: [doctor, install],
    });
    const run = async (typed: string[]) => {
      const { result } = await capture(() => cli.main(typed));
      assert.equal(result.exitCode, 0, typed.join(' '));
      return received.at(-1)!;
    };
    const filled = {
      RECIPE_CDP_PORT: '9541',
      CDP_PORT: '9541',
      RECIPE_WATCHER_PORT: '9341',
      WATCHER_PORT: '9341',
      METRO_PORT: '9341',
    };

    // The argv is exactly what was typed; the slot ports arrive in the environment.
    const plain = await run(['doctor', '--adapter', 'web', '--json']);
    assert.deepEqual(plain, { argv: ['--adapter', 'web', '--json'], env: filled });
    assert.deepEqual(harnessContext()?.ports, {
      cdp: {
        value: 9541,
        source: 'slot',
        filled: true,
        via: 'env',
        names: ['RECIPE_CDP_PORT', 'CDP_PORT'],
      },
      watcher: {
        value: 9341,
        source: 'slot',
        filled: true,
        via: 'env',
        names: ['RECIPE_WATCHER_PORT', 'WATCHER_PORT', 'METRO_PORT'],
      },
    });
    assert.match(
      formatHarnessContext(harnessContext()!),
      /ports cdp 9541 \(slot\), watcher 9341 \(slot\)$/u,
    );
    // ...for this invocation only: afterwards every name is back as it was, unset ones absent.
    assert.deepEqual(
      PORT_NAMES.map((name) => name in process.env),
      PORT_NAMES.map(() => false),
    );
    // A leaf's own help and a passthrough port reach it untouched.
    assert.deepEqual((await run(['install', '--adapter', 'web', '--', '--help'])).argv, [
      '--adapter',
      'web',
      '--',
      '--help',
    ]);
    // A port spelled after `--` is the leaf's: that port is not filled at all.
    assert.deepEqual(await run(['install', '--adapter', 'web', '--', '--watcher-port', '9400']), {
      argv: ['--adapter', 'web', '--', '--watcher-port', '9400'],
      env: {
        ...filled,
        RECIPE_WATCHER_PORT: undefined,
        WATCHER_PORT: undefined,
        METRO_PORT: undefined,
      },
    });
    // A typed spelling leaves that port to the command, the other one still fills.
    assert.deepEqual(await run(['doctor', '--adapter', 'web', '--port', '9400']), {
      argv: ['--adapter', 'web', '--port', '9400'],
      env: {
        ...filled,
        RECIPE_WATCHER_PORT: undefined,
        WATCHER_PORT: undefined,
        METRO_PORT: undefined,
      },
    });
    await run(['doctor', '--adapter', 'web', '--watcher-port=9405', '--port=9406']);
    assert.deepEqual(harnessContext()?.ports?.watcher, { source: 'flag' });
    // The user's environment wins over the slot: kept, reported, not filled.
    process.env.WATCHER_PORT = '9400';
    assert.deepEqual(await run(['doctor', '--adapter', 'web']), {
      argv: ['--adapter', 'web'],
      env: {
        ...filled,
        RECIPE_WATCHER_PORT: undefined,
        WATCHER_PORT: '9400',
        METRO_PORT: undefined,
      },
    });
    assert.deepEqual(harnessContext()?.ports?.watcher, {
      value: 9400,
      source: 'env',
      filled: false,
    });
    delete process.env.WATCHER_PORT;

    // The journal keeps exactly what was typed (each case in its own checkout,
    // so the newest journal is unambiguous).
    for (const typed of [
      ['--adapter', 'web', '--json'],
      ['--adapter', 'web', '--cdp-port=1'],
      ['--adapter', 'web', '--cdp-port', '2', '--cdp-port', '3'],
      ['--adapter', 'web', '--', 'x'],
    ]) {
      const own = fs.realpathSync(tempRoot());
      await run(['doctor', '--target', own, ...typed]);
      assert.deepEqual(readCommandJournal(own).record?.args, ['--target', own, ...typed]);
    }
    // A child the command spawns (a leaf script) inherits the filled environment.
    // (Last: a second createHarnessCli reconfigures the host this test journals with.)
    const spawning = command(
      'launch',
      { options: contractOptions(HELP, TARGET, portOptions) },
      {
        run: () => {
          const child = spawnSync(
            process.execPath,
            [
              '-e',
              `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(PORT_NAMES)}.map((n) => [n, process.env[n] ?? null]))))`,
            ],
            { encoding: 'utf8' },
          );
          childEnv.push(JSON.parse(child.stdout) as Record<string, string | null>);
          return child.status ?? 1;
        },
      },
    );
    const childEnv: Record<string, string | null>[] = [];
    const spawner = createHarnessCli({ ...cliOptions(), commands: [spawning] });
    process.env.UNRELATED_SETTING = 'kept';
    const before = { ...process.env };
    const launched = await capture(() => spawner.main(['launch', '--adapter', 'web']));
    assert.equal(launched.result.exitCode, 0);
    assert.deepEqual(childEnv, [filled]);
    assert.deepEqual({ ...process.env }, before);

    // No slot here: nothing is filled.
    process.chdir(tempRoot());
    assert.deepEqual((await run(['doctor', '--adapter', 'web'])).env, {
      RECIPE_CDP_PORT: undefined,
      CDP_PORT: undefined,
      RECIPE_WATCHER_PORT: undefined,
      WATCHER_PORT: undefined,
      METRO_PORT: undefined,
    });
  });

  // Two checkouts, each its own slot in one pool: coredev-3 on 8093, coredev-4 on 8094.
  function twoSlots(): { coreA: string; coreB: string } {
    const coreA = fs.realpathSync(tempRoot());
    const coreB = fs.realpathSync(tempRoot());
    const pools = fs.realpathSync(tempRoot());
    const slot = (id: string, repo: string, port: number) => ({
      id,
      repo,
      session: id,
      resources: { 'dev-server': { port } },
    });
    fs.writeFileSync(
      path.join(pools, 'macwork.json'),
      JSON.stringify({
        machine: 'macwork',
        host: 'localhost',
        slots: [slot('coredev-3', coreA, 8093), slot('coredev-4', coreB, 8094)],
      }),
    );
    process.env.FARMSLOT_POOL_DIR = pools;
    return { coreA, coreB };
  }
  const portOptions = contractOptions(HELP, TARGET, {
    '--adapter': valueOption(),
    '--watcher-port': valueOption(),
  });
  const childWatcherPort = () =>
    spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.WATCHER_PORT ?? "")'], {
      encoding: 'utf8',
    }).stdout;

  test('an invocation started while another dispatches waits its turn and gets its own ports', async () => {
    const { coreA, coreB } = twoSlots();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatched: string[] = [];
    const seen: { target: string; own: string | undefined; child: string }[] = [];
    const doctor = command(
      'doctor',
      { options: portOptions },
      {
        run: async (argv) => {
          const target = argv[argv.indexOf('--target') + 1] ?? '';
          dispatched.push(target);
          if (target === coreA) {
            enter();
            await gate;
          }
          seen.push({ target, own: process.env.WATCHER_PORT, child: childWatcherPort() });
          if (target === coreB) throw new Error('core-4 failed');
          return 0;
        },
      },
    );
    const cli = createHarnessCli({ ...cliOptions(), commands: [doctor] });
    const before = { ...process.env };
    const { result } = await capture(async () => {
      const first = cli.main(['doctor', '--adapter', 'web', '--target', coreA]);
      await entered;
      // The first is inside its dispatch; only now does the second start.
      const second = cli.main(['doctor', '--adapter', 'web', '--target', coreB]);
      // Give the second every chance to resolve and dispatch: without the queue it
      // would, and its fill would replace the first's port.
      for (let tries = 0; tries < 30 && !dispatched.includes(coreB); tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(dispatched, [coreA]);
      assert.equal(process.env.WATCHER_PORT, '8093');
      release();
      return Promise.all([first, second]);
    });
    assert.deepEqual(
      result.map((entry) => entry.exitCode),
      [0, 1],
    );
    assert.deepEqual(seen, [
      { target: coreA, own: '8093', child: '8093' },
      { target: coreB, own: '8094', child: '8094' },
    ]);
    assert.deepEqual({ ...process.env }, before);
  });

  test('a main() that rejects restores the environment and releases the queue', async () => {
    const { coreA } = twoSlots();
    // Commander refuses an alias equal to the command's name while main() builds
    // the program, after the context filled the port environment.
    const broken = createHarnessCli({
      ...cliOptions(),
      commands: [command('doctor', { options: portOptions }, { aliases: ['doctor'] })],
    });
    const before = { ...process.env };
    await assert.rejects(
      capture(() => broken.main(['doctor', '--adapter', 'web', '--target', coreA])),
      /alias can't be the same as its name/u,
    );
    assert.deepEqual({ ...process.env }, before);
    const seen: (string | undefined)[] = [];
    const next = createHarnessCli({
      ...cliOptions(),
      commands: [
        command(
          'doctor',
          { options: portOptions },
          {
            run: () => {
              seen.push(process.env.WATCHER_PORT);
              return 0;
            },
          },
        ),
      ],
    });
    const { result } = await capture(() =>
      next.main(['doctor', '--adapter', 'web', '--target', coreA]),
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(seen, ['8093']);
  });

  test('main() called from inside a running command fails at once instead of waiting forever', async () => {
    let nested: unknown;
    const cli = createHarnessCli({
      ...cliOptions(),
      commands: [
        command(
          'outer',
          { options: contractOptions(HELP) },
          {
            run: async () => {
              try {
                await cli.main(['inner']);
              } catch (error) {
                nested = error;
              }
              return 0;
            },
          },
        ),
        command('inner', { options: contractOptions(HELP) }),
      ],
    });
    const { result } = await capture(() => cli.main(['outer']));
    assert.equal(result.exitCode, 0);
    assert.match(String(nested), /main\(\) was called from inside a running command/u);
    // The queue is free again for the next invocation.
    assert.equal((await capture(() => cli.main(['inner']))).result.exitCode, 0);
  });

  test('a hidden command (shell completion) gets the detected adapter; a tie never refuses it', async () => {
    const checkout = fs.realpathSync(tempRoot());
    process.chdir(checkout);
    const answered: (string | undefined)[] = [];
    const complete: HarnessCommand = {
      name: 'completion-candidates',
      hidden: true,
      context: 'adapter',
      run: () => {
        answered.push(contextAdapter(process.cwd()));
        return 0;
      },
    };
    const mobileLike = createAdapterRegistry();
    mobileLike.register({ ...fakeAdapter('mobile'), detect: { files: () => true } });
    const cli = createHarnessCli({ ...cliOptions({ adapters: mobileLike }), commands: [complete] });
    const found = await capture(() => cli.main(['completion-candidates', 'call', '']));
    assert.equal(found.result.exitCode, 0);
    assert.equal(found.stderr, '');
    assert.deepEqual(answered, ['mobile']);

    const tied = createAdapterRegistry();
    tied.register({ ...fakeAdapter('mobile'), detect: { files: () => true } });
    tied.register({ ...fakeAdapter('web'), detect: { files: () => true } });
    const quiet = createHarnessCli({ ...cliOptions({ adapters: tied }), commands: [complete] });
    const ambiguous = await capture(() => quiet.main(['completion-candidates', 'call', '']));
    assert.deepEqual([ambiguous.result.exitCode, ambiguous.stdout, ambiguous.stderr], [0, '', '']);
    assert.equal(answered.at(-1), undefined);
    assert.equal(harnessContext()?.target.value, checkout);
  });

  test('a command without context options detects nothing; a hidden one loads a plugin only when it opts in', async () => {
    const checkout = terminalCheckout();
    process.chdir(checkout);
    process.env.RECIPE_LIBRARY_PATH = `terms=${detectingLibrary({
      terminal: { remote: ['va-mmcx-terminal'] },
    })}`;
    const answered: (string | undefined)[] = [];
    const complete: HarnessCommand = {
      name: 'completion-candidates',
      hidden: true,
      context: 'adapter',
      run: () => {
        answered.push(contextAdapter(process.cwd()));
        return 0;
      },
    };
    const options = contextOptions([]);
    const cli = createHarnessCli({ ...options, commands: [...options.commands, complete] });
    await capture(() => cli.main(['update']));
    assert.deepEqual(imported(), []);
    assert.equal(harnessContext(), undefined);
    // Without the opt-in a hidden command resolves its target and slot only.
    const plain = await capture(() => cli.main(['runtime-probe']));
    assert.equal(plain.stderr, '');
    assert.deepEqual(imported(), []);
    assert.equal(harnessContext()?.adapter, undefined);
    assert.equal(harnessContext()?.target.value, checkout);
    // With it, completion gets the detected plugin, loaded alone.
    const completion = await capture(() => cli.main(['completion-candidates', 'call', '']));
    assert.equal(completion.stderr, '');
    assert.deepEqual(imported(), ['terminal']);
    assert.deepEqual(answered, ['terminal']);
  });

  test('a tie under help or a hidden opt-in imports, adopts and fences nothing', async () => {
    const checkout = terminalCheckout();
    process.chdir(checkout);
    process.env.RECIPE_LIBRARY_PATH = `terms=${detectingLibrary({
      terminal: { packageDependencies: ['next'] },
      shop: { packageDependencies: ['next'] },
    })}`;
    const adopted: string[] = [];
    const fenced: string[] = [];
    const complete: HarnessCommand = {
      name: 'completion-candidates',
      hidden: true,
      context: 'adapter',
      run: () => 0,
    };
    const options = contextOptions([]);
    const cli = createHarnessCli({
      ...options,
      commands: [...options.commands, complete],
      adopt: (adapter) => {
        adopted.push(adapter.id);
        return adapter;
      },
      afterAdapterLoad: (id) => {
        fenced.push(id);
      },
    });
    for (const argv of [
      ['status', '--help'],
      ['completion-candidates', 'call', ''],
    ]) {
      const { result, stderr } = await capture(() => cli.main(argv));
      assert.equal(result.exitCode, 0, argv.join(' '));
      assert.equal(stderr, '');
      assert.equal(harnessContext()?.adapter, undefined);
    }
    assert.deepEqual([imported(), adopted, fenced], [[], [], []]);
  });
});
