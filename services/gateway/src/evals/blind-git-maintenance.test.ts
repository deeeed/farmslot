import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { type BlindGitSpec, buildBlindGitCommand } from './blind-git.js';

test('blind isolate and restore suppress automatic maintenance without persisting config', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'blind-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_PARAMETERS: '',
    GIT_CONFIG_COUNT: '0',
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
      env,
      encoding: 'utf8',
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'gc.auto', '1');
  git('config', 'maintenance.auto', 'true');
  writeFileSync(path.join(repo, 'value.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  // Two loose objects in Git's sampled bucket exceed gc.auto=1's threshold.
  let sampled = 0;
  for (let i = 0; sampled < 2; i++) {
    const content = `synthetic loose object ${i}`;
    const hash = createHash('sha1')
      .update(`blob ${Buffer.byteLength(content)}\0${content}`)
      .digest('hex');
    if (!hash.startsWith('17')) continue;
    execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { env, input: content });
    sampled++;
  }
  // Prove the fixture is eligible without allowing the control to detach or pack.
  const hook = path.join(repo, '.git/hooks/pre-auto-gc');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const controlTrace = path.join(root, 'control.jsonl');
  execFileSync('git', ['-C', repo, 'gc', '--auto', '--no-detach'], {
    env: { ...env, GIT_TRACE2_EVENT: controlTrace },
    timeout: 30_000,
  });
  assert.match(readFileSync(controlTrace, 'utf8'), /pre-auto-gc/);
  const config = readFileSync(path.join(repo, '.git/config'), 'utf8');
  const spec: BlindGitSpec = {
    slotId: 'fixture-slot',
    slotEpoch: 1,
    repo,
    capsule: path.join(root, 'capsule'),
    runId: 'fixture-trial',
    branch: 'eval/fixture',
    baseSha,
    referenceCommits: [],
  };
  for (const action of ['isolate', 'restore'] as const) {
    const trace = path.join(root, `${action}.jsonl`);
    execFileSync('bash', ['-c', buildBlindGitCommand(action, spec)], {
      env: {
        ...env,
        GIT_TRACE2_EVENT: trace,
        GIT_TRACE2_CONFIG_PARAMS: 'gc.auto,maintenance.auto',
      },
      timeout: 30_000,
    });
    const events = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const [key, value] of [
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
    ]) {
      const settings = events.filter((event) => event.event === 'def_param' && event.param === key);
      assert.ok(settings.length > 0, `${action} traced ${key}`);
      assert.ok(
        settings.some((event) => event.scope === 'command' && event.value === value),
        `${action} must suppress ${key} at command scope`,
      );
    }
    assert.deepEqual(
      events.filter(
        (event) =>
          event.event === 'child_start' &&
          event.argv.some((arg: string) => /^(maintenance|gc)$/.test(arg)),
      ),
      [],
    );
  }
  assert.equal(readFileSync(path.join(repo, '.git/config'), 'utf8'), config);
});
