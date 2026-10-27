// Opt-in real Git regression, excluded from the default unit suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildBranchFreshnessProbeScript,
  parseBranchFreshnessProbeOutput,
} from './branch-freshness.js';

test('a main-only fetch mapping still refreshes a conflicting stacked base', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'narrow-base-'));
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['init', '-q', '--bare', origin]);
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'proof.txt'), 'base\n');
    git('add', 'proof.txt');
    git('commit', '-qm', 'test: seed base');
    const base = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', origin);
    git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    git('push', '-q', 'origin', 'main', 'main:refs/heads/upstream');
    // Preparation can explicitly materialize this ref outside the configured mapping.
    git('update-ref', 'refs/remotes/origin/upstream', base);
    git('switch', '-qc', 'feature');
    writeFileSync(path.join(repo, 'proof.txt'), 'feature\n');
    git('commit', '-qam', 'test: feature change');
    const head = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    writeFileSync(path.join(repo, 'proof.txt'), 'upstream\n');
    git('commit', '-qam', 'test: advance upstream');
    const advanced = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', 'main:refs/heads/upstream');
    git('switch', '-q', 'feature');
    assert.equal(git('rev-parse', 'origin/upstream'), base);
    const output = execFileSync('bash', ['-c', buildBranchFreshnessProbeScript(repo, 'upstream')], {
      encoding: 'utf8',
    });
    const probe = parseBranchFreshnessProbeOutput(output, 'upstream');
    assert.equal(probe.fetchOk, true);
    assert.equal(probe.mergeConflicts, true, output);
    assert.equal(git('rev-parse', 'origin/upstream'), advanced);
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(git('status', '--porcelain'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
