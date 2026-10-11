import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  booleanOption,
  type CommandContract,
  type ContractedCommand,
  optionalValueOption,
  valueOption,
} from '../src/harness/command-contract.js';
import { parseProjectInvocation } from '../src/harness/project-command.js';

const contract: CommandContract = {
  options: { '--plan': booleanOption(), '--library': valueOption() },
  positionals: [{ label: 'recipe' }],
  minimumPositionals: 1,
  variadic: { label: 'key=value', pattern: /^[^=\s]+=.*/u },
};
const providerCommands: ContractedCommand[] = [
  {
    name: 'run',
    example: 'run smoke',
    contract: {
      options: {
        '--consent-file': valueOption(),
        '--sandbox': booleanOption(),
        '--observe': optionalValueOption(['full', 'off']),
        '--fast': valueOption(['cached', 'fresh']),
        '--plan': valueOption(),
      },
    },
  },
];

test('host plan grammar stays authoritative while provider flags retain their values', () => {
  const parsed = parseProjectInvocation(
    'run',
    {
      contract,
      argv: [
        'smoke',
        '--consent-file',
        'reviewed.json',
        '--sandbox',
        '--plan',
        'market=ETH',
        '--library',
        'one=/one',
        '--library=two=/two',
      ],
    },
    providerCommands,
  );
  assert.deepEqual(parsed.positional, ['smoke', 'market=ETH']);
  assert.deepEqual(parsed.options, {
    consentFile: 'reviewed.json',
    sandbox: true,
    plan: true,
    library: ['one=/one', 'two=/two'],
  });
});

test('declared option kinds control token consumption, including optional inline values', () => {
  for (const [argv, expected] of [
    [['smoke', '--observe', 'market=ETH', '--fast', 'cached'], { observe: true, fast: 'cached' }],
    [['smoke', '--observe=off', 'market=ETH'], { observe: 'off' }],
  ] as const) {
    const parsed = parseProjectInvocation('run', { contract, argv }, providerCommands);
    assert.deepEqual(parsed.positional, ['smoke', 'market=ETH']);
    assert.deepEqual(parsed.options, expected);
  }
});

test('execution typos and malformed provider flags fail with stable usage codes', () => {
  for (const [argv, code] of [
    [['smoke', '--plna'], 'CLI_UNKNOWN_OPTION'],
    [['smoke', '--plan=false'], 'CLI_INVALID_OPTION_VALUE'],
    [['smoke', '--consent-file', '--plan'], 'CLI_MISSING_OPTION_VALUE'],
    [['smoke', '--observe=unknown'], 'CLI_INVALID_OPTION_VALUE'],
    [['smoke', 'unexpected'], 'CLI_INVALID_POSITIONAL'],
    [['smoke', '--', '--plan'], 'CLI_UNEXPECTED_PASSTHROUGH'],
  ] as const) {
    assert.throws(() => parseProjectInvocation('run', { contract, argv }, providerCommands), {
      code,
      exitCode: 2,
    });
  }
});

test('a provider cannot introduce a preview flag for an executing command that lacks that mode', () => {
  for (const flag of ['--plan', '--describe']) {
    assert.throws(
      () =>
        parseProjectInvocation(
          'call',
          {
            argv: ['command', flag],
            contract: { options: {}, positionals: [{ label: 'action' }], minimumPositionals: 1 },
          },
          [
            {
              name: 'call',
              example: 'call command',
              contract: { options: { [flag]: booleanOption() } },
            },
          ],
        ),
      { code: 'CLI_UNKNOWN_OPTION', exitCode: 2 },
    );
  }
});
