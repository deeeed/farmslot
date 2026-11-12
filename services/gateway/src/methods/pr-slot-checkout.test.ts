import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { PRListFilters } from '../integrations/github-client.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'pr-slot-checkout-'));
// Only the checkout's own config: no machine-wide url rewrites reach the origin slug.
const emptyGlobal = path.join(scratch, 'gitconfig');
writeFileSync(emptyGlobal, '');
const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_GLOBAL = emptyGlobal;

function checkout(name: string, origin: string): string {
  const dir = path.join(scratch, name);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

let slotRepo = '';
const lookups: Array<[string, string]> = [];
let lookupAnswer: () => Promise<{ number: number; baseRefName?: string } | null>;
const callers: Array<string | undefined> = [];
const fleet = await import('../fleet/state.js');
mock.module('../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({
      slots: [{ slot: 's1', project: 'app', branch: 'feat/a', enabled: true, session: 's1' }],
    }),
    loadProjectConfig: async () => ({ name: 'app', defaultBranch: 'main' }),
    loadProjectConfigs: async () => [{ name: 'app', defaultBranch: 'main' }],
    loadPoolConfigs: async () => [
      { host: 'localhost', machine: 'test', slots: [{ id: 's1', repo: slotRepo }] },
    ],
  },
});
const githubCliModule = await import('../host-services/github-cli.js');
mock.module('../host-services/github-cli.js', {
  namedExports: {
    ...githubCliModule,
    githubCli: {
      ...githubCliModule.githubCli,
      checkoutPRForBranch: async (cwd: string, branch: string) => {
        lookups.push([cwd, branch]);
        return lookupAnswer();
      },
    },
  },
});
const githubClient = await import('../integrations/github-client.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...githubClient,
    github: {
      ...githubClient.github,
      prListFields: async (
        _repo: string,
        _fields: string[],
        filters: PRListFilters,
        opts?: { caller?: string },
      ) => {
        callers.push(opts?.caller);
        assert.equal(filters.head, 'feat/a');
        return [{ number: 42, baseRefName: 'main' }];
      },
    },
  },
});
const { prForSlot, readPRForSlot } = await import('./pr.js');

after(() => {
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
  rmSync(scratch, { recursive: true, force: true });
});

test('a slot without ci.repo asks gh in its checkout and pairs the answer with the origin slug', async () => {
  // gh resolves SSH host aliases itself; the reported repository is the origin slug, as before.
  slotRepo = checkout('alias', 'git@github.com-deeeed:deeeed/farmslot.git');
  lookups.length = 0;
  lookupAnswer = async () => ({ number: 42, baseRefName: 'release' });
  assert.deepEqual(await prForSlot({ slotId: 's1' }), {
    pr: 42,
    repo: 'deeeed/farmslot',
    baseRef: 'release',
  });
  assert.deepEqual(lookups, [[slotRepo, 'feat/a']]);

  slotRepo = checkout('enterprise', 'git@ghe.example.com:team/app.git');
  lookupAnswer = async () => ({ number: 7 });
  assert.deepEqual(
    await prForSlot({ slotId: 's1' }),
    { pr: 7, repo: null, baseRef: 'main' },
    'a remote that is not github.com reports no repository slug',
  );

  for (const answer of [async () => null, async () => Promise.reject(new Error('gh: not found'))]) {
    lookupAnswer = answer;
    assert.deepEqual(await prForSlot({ slotId: 's1' }), { pr: null, repo: null, baseRef: 'main' });
  }
});

test('managed slot discovery keeps its spend attribution', async () => {
  slotRepo = checkout('managed', 'git@github.com:me/app.git');
  callers.length = 0;
  const found = await readPRForSlot({ slotId: 's1' }, { legacyInterest: false });
  assert.equal(found.pr, 42);
  assert.deepEqual(callers, ['pr.list:discovery']);
});
