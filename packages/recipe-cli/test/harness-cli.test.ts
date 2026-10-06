import assert from 'node:assert/strict';
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
  booleanOption,
  type CommandContract,
  configureHarnessAdapters,
  configureHarnessHost,
  type ContractedCommand,
  contractOptions,
  createHarnessCli,
  harnessAdapters,
  type HarnessCliOptions,
  type HarnessCommand,
  harnessHost,
  optionalValueOption,
  optionValues,
  publicCommandTokens,
  type PublicHarnessCommand,
  type RecipeCatalog,
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
        '--arg': optionalValueOption(),
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
  // No personal library from ~/.farmslot reaches the tests.
  process.env.FARMSLOT_HOME = tempRoot();
  (globalThis as Record<string, unknown>).__pluginImports = [];
  process.chdir(tempRoot());
});
afterEach(() => {
  process.chdir(savedCwd);
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
    const catalog = {} as NonNullable<HarnessCliOptions['catalog']>;
    const cli = createHarnessCli(cliOptions({ catalog }));
    const { result, stderr } = await capture(() => cli.main(['call', 'x', '--arg', '--help']));
    assert.deepEqual(result, { exitCode: 2, exit: 'now' });
    assert.equal(stderr, '--arg requires k=v.\n');
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
        '--arg': optionalValueOption(),
      }),
      positionals: [{ label: 'action' }],
    });
    const cli = createHarnessCli({
      ...pluginOptions(),
      commands: [...shopCommands().filter((entry) => entry.name !== 'call'), call],
      catalog: {} as NonNullable<HarnessCliOptions['catalog']>,
    });
    // --arg with no pair stops the action help early, after the load.
    const { result } = await capture(() =>
      cli.main(['call', 'x', '--adapter', 'helped', '--arg', '--help']),
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
