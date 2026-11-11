import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { PRListFilters } from '../integrations/github-client.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'pr-slot-remote-'));
// Only the checkout's own config: no machine-wide remotes leak into the choice.
const emptyGlobal = path.join(scratch, 'gitconfig');
writeFileSync(emptyGlobal, '');
const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_GLOBAL = emptyGlobal;

function checkout(name: string, remotes: Record<string, string>, resolved?: string): string {
  const dir = path.join(scratch, name);
  execFileSync('git', ['init', '-q', dir]);
  for (const [remote, url] of Object.entries(remotes))
    execFileSync('git', ['-C', dir, 'remote', 'add', remote, url]);
  if (resolved)
    execFileSync('git', ['-C', dir, 'config', `remote.${resolved}.gh-resolved`, 'base']);
  return dir;
}

let slotRepo = '';
const listed: string[] = [];
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
const githubClient = await import('../integrations/github-client.js');
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...githubClient,
    github: {
      ...githubClient.github,
      prListFields: async (
        repo: string,
        _fields: string[],
        filters: PRListFilters,
        opts?: { caller?: string },
      ) => {
        listed.push(repo);
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

test('a slot without ci.repo looks its PR up in the repository gh would pick', async () => {
  const cases: Array<[string, string, Record<string, string>, string?]> = [
    [
      'fork origin plus upstream',
      'github.com/canonical/app',
      { origin: 'git@github.com:me/app.git', upstream: 'https://github.com/canonical/app.git' },
    ],
    [
      'gh repo set-default',
      'github.com/me/app',
      { origin: 'git@github.com:me/app.git', upstream: 'https://github.com/canonical/app.git' },
      'origin',
    ],
    [
      'Enterprise remote',
      'ghe.example.com/team/app',
      { origin: 'ssh://git@ghe.example.com/team/app.git' },
    ],
  ];
  for (const [name, expected, remotes, resolved] of cases) {
    slotRepo = checkout(name.replaceAll(' ', '-'), remotes, resolved);
    listed.length = 0;
    const result = await prForSlot({ slotId: 's1' });
    assert.deepEqual(listed, [expected], name);
    assert.deepEqual(result, {
      pr: 42,
      repo: expected.split('/').slice(1).join('/'),
      baseRef: 'main',
    });
  }
});

test('managed slot discovery keeps its spend attribution', async () => {
  slotRepo = checkout('managed', { origin: 'git@github.com:me/app.git' });
  callers.length = 0;
  const found = await readPRForSlot({ slotId: 's1' }, { legacyInterest: false });
  assert.equal(found.pr, 42);
  assert.deepEqual(callers, ['pr.list:discovery']);
});
