import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import { execOnSlot } from '../core/exec.js';
import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { shellQuote } from '../core/tmux.js';
import { makeVars } from '../runners/test-fixtures.js';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
let repo = '';
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => makeVars({ remoteRepo: repo }),
    loadProjectVars: async () => ({ projectJson: { default_branch: 'main' } }),
  },
});
const { probeSlotBranchFreshness } = await import('./branch-freshness.js');
const { captureRunDiffSnapshot } = await import('./diff-artifacts.js');
const { makeRun } = await import('./test-fixtures.js');

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'farm-git-boundaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  repo = path.join(root, 'slot');
  const origin = path.join(root, 'origin.git');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const git = (...args: string[]) =>
    execFileSync(realGit, ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync(realGit, ['init', '-q', '-b', 'main', repo]);
  execFileSync(realGit, ['init', '-q', '--bare', origin]);
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'base.ts'), 'export const base = true;\n');
  git('add', '.');
  git('commit', '-qm', 'test: base');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'upstream');
  writeFileSync(path.join(repo, 'upstream.ts'), 'export const upstream = true;\n');
  git('add', '.');
  git('commit', '-qm', 'test: upstream');
  const upstreamSha = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'upstream');
  git('checkout', '-qb', 'feature');
  writeFileSync(path.join(repo, 'child.ts'), 'export const child = true;\n');
  git('add', '.');
  git('commit', '-qm', 'test: child');
  git('config', 'gc.auto', '1');
  git('config', 'maintenance.auto', 'true');
  const before = readFileSync(path.join(repo, '.git/config'), 'utf8');
  const log = path.join(root, 'git-calls');
  // Record effective settings at each Git invocation, then run the real command.
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$*" "$(${shellQuote(realGit)} config --get gc.auto)" "$(${shellQuote(realGit)} config --get maintenance.auto)" >> ${shellQuote(log)}\nexec ${shellQuote(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  const run = <T>(fn: () => Promise<T>) =>
    withSlotCommandExecutor(async (vars, command) => {
      const result = spawnSync('bash', ['-c', command], {
        cwd: vars.remoteRepo,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      });
      if (result.error) throw result.error;
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
    }, fn);
  const vars = makeVars({ remoteRepo: repo });
  const assertSettings = async (expectedFetches: number) => {
    const fetches = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => /^(?:-C \S+ )?fetch /.test(line));
    assert.equal(fetches.length, expectedFetches);
    for (const fetch of fetches) assert.match(fetch, /\t0\tfalse$/);
    assert.equal(readFileSync(path.join(repo, '.git/config'), 'utf8'), before);
    assert.equal(
      (
        await run(() =>
          execOnSlot(vars, 'git config --get gc.auto && git config --get maintenance.auto'),
        )
      ).stdout,
      '1\ntrue\n',
    );
  };
  return { vars, upstreamSha, assertSettings, run };
}

test('publication freshness fetch suppresses maintenance without changing worker config', async (t) => {
  const f = fixture(t);
  const result = await f.run(() => probeSlotBranchFreshness(f.vars, 'main'));
  assert.equal(result?.fetchOk, true);
  assert.equal(result?.aheadMain, 2);
  assert.equal(result?.mergeConflicts, false);
  await f.assertSettings(1);
});

test('stacked diff capture suppresses both base fetches and preserves the child diff', async (t) => {
  const f = fixture(t);
  const result = await f.run(() =>
    captureRunDiffSnapshot({
      ...makeRun({ slotId: f.vars.slotId, branch: 'feature' }),
      stack: {
        upstreamNodeId: 'upstream-node',
        upstreamRunId: 'upstream-run',
        baseBranch: 'upstream',
        upstreamPrNumber: 1,
        resolvedSha: f.upstreamSha,
      },
    }),
  );
  assert.equal(result.available, true);
  assert.equal(result.files, 1);
  assert.match(result.diffText ?? '', /diff --git a\/child.ts b\/child.ts/);
  assert.doesNotMatch(result.diffText ?? '', /diff --git a\/upstream.ts/);
  await f.assertSettings(2);
});
