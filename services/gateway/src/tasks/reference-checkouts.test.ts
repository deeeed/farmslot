import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const core = await import('../core/index.js');
let commands: string[] = [];
let reply: { stdout: string; exitCode: number } = { stdout: '', exitCode: 0 };
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    execOnSlot: async (_slotVars: unknown, command: string) => {
      commands.push(command);
      return { ...reply, stderr: '' };
    },
  },
});
const { resolveReferenceCheckouts } = await import('./reference-checkouts.js');
const slotVars = { remoteRepo: '/home/dev/metamask/va-mmcx-terminal-1' } as never;
const parentDir = '/home/dev/metamask';
const terminalReferences = {
  mobile: { repo_url: 'git@github.com:MetaMask/metamask-mobile.git', local_name: 'mobile-ref' },
  extension: {
    repo_url: 'git@github.com:MetaMask/metamask-extension.git',
    local_name: 'extension-ref',
  },
  core: { repo_url: 'git@github.com:MetaMask/core.git', local_name: 'core-ref' },
  perps_library: { repo_url: 'git@github.com:MetaMask/perps.git', local_name: 'perps' },
};
beforeEach(() => {
  commands = [];
  reply = { stdout: '', exitCode: 0 };
});

test('every declared codebase is resolved with the revision the worker cites', async () => {
  reply = {
    exitCode: 0,
    stdout:
      'mobile\tbbb1111111111111111111111111111111111111\nextension\tccc2222222222222222222222222222222222222\ncore\tddd3333333333333333333333333333333333333\n',
  };
  const references = await resolveReferenceCheckouts(slotVars, terminalReferences, parentDir);
  assert.deepEqual(references, [
    {
      name: 'mobile',
      path: '/home/dev/metamask/mobile-ref',
      present: true,
      headSha: 'bbb1111111111111111111111111111111111111',
    },
    {
      name: 'extension',
      path: '/home/dev/metamask/extension-ref',
      present: true,
      headSha: 'ccc2222222222222222222222222222222222222',
    },
    {
      name: 'core',
      path: '/home/dev/metamask/core-ref',
      present: true,
      headSha: 'ddd3333333333333333333333333333333333333',
    },
  ]);
  assert.equal(commands.length, 1, 'one command, so a remote slot costs one round trip');
  assert.ok(
    !commands[0].includes('perps'),
    'a recipe library is bound through support, not compared against',
  );
});

test('a checkout the machine does not have is reported absent, never substituted', async () => {
  // The Mobile sibling is not cloned: git prints nothing for it.
  reply = { exitCode: 0, stdout: 'mobile\t\nextension\t\ncore\tddd3333\n' };
  const references = await resolveReferenceCheckouts(slotVars, terminalReferences, parentDir);
  assert.deepEqual(
    references.map((reference) => [reference.name, reference.present]),
    [
      ['mobile', false],
      ['extension', false],
      ['core', true],
    ],
  );
  assert.equal(references[0].path, '/home/dev/metamask/mobile-ref', 'the path it should have');
  assert.equal(references[0].headSha, undefined, 'and no revision anyone read');
  assert.ok(
    !commands[0].includes('mobile-1') && !commands[0].includes('metamask-mobile-1'),
    'an active slot checkout of that project is never probed as a reference',
  );
});

test('a probe that could not run claims no revisions', async () => {
  reply = { exitCode: 127, stdout: '' };
  const references = await resolveReferenceCheckouts(slotVars, terminalReferences, parentDir);
  assert.deepEqual(
    references.map((reference) => reference.present),
    [false, false, false],
  );
});

test('a project that declares no reference repos probes nothing', async () => {
  assert.deepEqual(await resolveReferenceCheckouts(slotVars, undefined, parentDir), []);
  assert.deepEqual(
    await resolveReferenceCheckouts(
      slotVars,
      { perps_library: { repo_url: 'git@github.com:MetaMask/perps.git', local_name: 'perps' } },
      parentDir,
    ),
    [],
  );
  assert.deepEqual(commands, []);
});
