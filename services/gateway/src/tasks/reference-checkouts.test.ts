import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, mock, test } from 'node:test';

const core = await import('../core/index.js');
let commands: string[] = [];
let reply: { stdout: string; exitCode: number } = { stdout: '', exitCode: 0 };
/** When set, the mock runs the command the resolver built instead of answering it. */
let runForReal = false;
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    execOnSlot: async (_slotVars: unknown, command: string) => {
      commands.push(command);
      if (!runForReal) return { ...reply, stderr: '' };
      return {
        stdout: execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }),
        stderr: '',
        exitCode: 0,
      };
    },
  },
});
const { resolveReferenceCheckouts } = await import('./reference-checkouts.js');
const SLOT_REPO = '/home/dev/metamask/va-mmcx-terminal-1';
const slotVars = { remoteRepo: SLOT_REPO } as never;
/** References are siblings of the slot checkout. */
const parentDir = SLOT_REPO;
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
  runForReal = false;
});

test('every declared codebase is resolved with the revision the worker cites', async () => {
  reply = {
    exitCode: 0,
    stdout: `mobile\t${'b'.repeat(40)}\nextension\t${'c'.repeat(40)}\ncore\t${'d'.repeat(40)}\n`,
  };
  const references = await resolveReferenceCheckouts(slotVars, terminalReferences, parentDir);
  assert.deepEqual(references, [
    {
      name: 'mobile',
      path: '/home/dev/metamask/mobile-ref',
      present: true,
      headSha: 'b'.repeat(40),
    },
    {
      name: 'extension',
      path: '/home/dev/metamask/extension-ref',
      present: true,
      headSha: 'c'.repeat(40),
    },
    {
      name: 'core',
      path: '/home/dev/metamask/core-ref',
      present: true,
      headSha: 'd'.repeat(40),
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
  reply = { exitCode: 0, stdout: `mobile\t\nextension\t\ncore\t${'d'.repeat(40)}\n` };
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

test('a line that is not a full revision is not taken for one', async () => {
  // A truncated or interrupted probe line names no revision anybody can cite.
  reply = { exitCode: 0, stdout: 'mobile\tddd333\nextension\tnot-a-sha\ncore\tHEAD\n' };
  const references = await resolveReferenceCheckouts(slotVars, terminalReferences, parentDir);
  assert.deepEqual(
    references.map((reference) => reference.present),
    [false, false, false],
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

// The tests above feed canned stdout: they prove the parse, not the command. This one
// runs the command the resolver actually builds, against real checkouts, so a command
// that cannot produce that output fails here.
test('the command it builds reads real checkouts through a real shell', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'reference-checkouts-'));
  try {
    const slot = path.join(root, 'terminal-1');
    mkdirSync(slot, { recursive: true });
    const cloned = path.join(root, 'mobile-ref');
    execFileSync('git', ['init', '-q', '--initial-branch=main', cloned], { stdio: 'ignore' });
    execFileSync('git', ['-C', cloned, 'commit', '-q', '--allow-empty', '-m', 'first'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    const head = execFileSync('git', ['-C', cloned, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    // A repository with no commit yet: plain `rev-parse HEAD` echoes the literal
    // 'HEAD', which must never be recorded as a revision.
    const unborn = path.join(root, 'extension-ref');
    execFileSync('git', ['init', '-q', '--initial-branch=main', unborn], { stdio: 'ignore' });
    runForReal = true;
    const references = await resolveReferenceCheckouts(
      { remoteRepo: slot } as never,
      {
        mobile: {
          repo_url: 'git@github.com:MetaMask/metamask-mobile.git',
          local_name: 'mobile-ref',
        },
        extension: {
          repo_url: 'git@github.com:MetaMask/metamask-extension.git',
          local_name: 'extension-ref',
        },
        core: { repo_url: 'git@github.com:MetaMask/core.git', local_name: 'core-ref' },
      },
      slot,
    );
    assert.deepEqual(references, [
      { name: 'mobile', path: cloned, present: true, headSha: head },
      { name: 'extension', path: unborn, present: false },
      { name: 'core', path: path.join(root, 'core-ref'), present: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
