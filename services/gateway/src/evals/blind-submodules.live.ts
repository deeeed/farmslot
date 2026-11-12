// Synthetic Git repositories only. Run manually with the blind Git live suite.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { shSingleQuote as q } from '../../../../scripts/lib/shell-quote.mjs';

import { type BlindGitSpec, buildBlindGitCommand, withBlindTrialBoundary } from './blind-git.js';

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [
          path.relative(directory, file),
          `${statSync(file).mode}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`,
        ];
      }),
  );
}

for (const layout of [
  'single',
  'nested',
  'linked',
  'embedded',
  'proof',
  'interrupted',
  'preparing',
  'rollback',
] as const) {
  test(`blind Git preserves ${layout} submodules without reference objects`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blind-submodules-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    mkdirSync(home);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
    };
    const git = (repo: string, ...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    const commit = (repo: string, message: string) => {
      git(repo, 'add', '.');
      git(
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        message,
      );
      return git(repo, 'rev-parse', 'HEAD');
    };
    const init = (name: string) => {
      const repo = path.join(root, name);
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(path.join(repo, 'value.txt'), 'base\n');
      commit(repo, 'base');
      return repo;
    };
    const add = (repo: string, upstream: string, name: string, location: string) =>
      git(
        repo,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--name',
        name,
        `file://${upstream}`,
        location,
      );
    const upstream = init('module-upstream');
    if (layout === 'nested') {
      add(upstream, init('leaf-upstream'), 'leaf-name', 'deps/leaf');
      commit(upstream, 'nested dependency');
    }
    const source = init('source');
    const linked = layout === 'linked' || layout === 'preparing';
    const repo = linked ? path.join(root, 'linked') : source;
    if (linked) git(source, 'worktree', 'add', '-q', '--detach', repo);
    add(repo, upstream, 'sdk-name', 'deps/sdk');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
    const comparisonBase = commit(repo, 'dependency base');
    const module = path.join(repo, 'deps/sdk');
    const modules = [module];
    if (layout === 'nested') modules.unshift(path.join(module, 'deps/leaf'));
    const beforeModules = modules.map((p) => git(p, 'rev-parse', 'HEAD'));
    if (layout === 'proof') {
      writeFileSync(path.join(module, 'value.txt'), 'supplied implementation\n');
      commit(module, 'supplied module implementation');
      commit(repo, 'supplied implementation');
    }
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    const moduleBases = modules.map((p) => git(p, 'rev-parse', 'HEAD'));
    const referenceCommits = modules.map((p) => {
      writeFileSync(path.join(p, 'value.txt'), 'reference answer\n');
      writeFileSync(path.join(p, 'answer.txt'), 'reference-only file\n');
      return commit(p, 'hidden module answer');
    });
    const reference = commit(repo, 'hidden superproject answer');
    const originalDirectory = git(repo, 'rev-parse', '--absolute-git-dir');
    if (layout === 'embedded') {
      const directory = git(module, 'rev-parse', '--absolute-git-dir');
      rmSync(path.join(module, '.git'));
      renameSync(directory, path.join(module, '.git'));
      git(module, 'config', '--unset', 'core.worktree');
    }
    const originalModules = snapshot(path.join(originalDirectory, 'modules'));
    const originalGitfiles = modules.map((p) =>
      layout === 'embedded' ? snapshot(path.join(p, '.git')) : readFileSync(path.join(p, '.git')),
    );
    const spec: BlindGitSpec = {
      slotId: 'synthetic-slot',
      slotEpoch: 1,
      repo,
      capsule: path.join(root, '.farmslot-blind-evals/trial'),
      runId: 'trial',
      branch: 'eval/submodules',
      baseSha,
      referenceCommits: [reference],
      ...(layout === 'proof'
        ? {
            proof: {
              baseSha: comparisonBase,
              headSha: baseSha,
              treeSha: git(repo, 'rev-parse', `${baseSha}^{tree}`),
              diffSha256: 'a'.repeat(64),
            },
          }
        : {}),
    };
    // Even an operator's recursive Git preference must not alter retained modules.
    git(repo, 'config', 'submodule.recurse', 'true');
    const command = (action: 'isolate' | 'boundary' | 'restore') =>
      JSON.parse(
        execFileSync('bash', ['-c', buildBlindGitCommand(action, spec)], {
          env: { ...env, GIT_OPTIONAL_LOCKS: undefined },
          encoding: 'utf8',
          timeout: 60_000,
        }),
      );
    try {
      if (layout === 'preparing' || layout === 'rollback') {
        const result = spawnSync(
          'python3',
          [
            '-c',
            `
import json, os, runpy, sys
module = runpy.run_path(sys.argv[1], run_name='fixture')
if sys.argv[3] == 'preparing':
    save = module['save']
    def interrupt(path, value):
        if value.get('phase') == 'isolated':
            os._exit(75)
        save(path, value)
    module['isolate'].__globals__['save'] = interrupt
else:
    def reject(*args, **kwargs):
        raise RuntimeError('fixture failed verification')
    module['isolate'].__globals__['verify'] = reject
module['isolate'](json.loads(sys.argv[2]))
`,
            new URL('./blind-git.py', import.meta.url).pathname,
            JSON.stringify(spec),
            layout,
          ],
          { env, encoding: 'utf8', timeout: 60_000 },
        );
        if (layout === 'preparing') assert.equal(result.status, 75);
        else {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /fixture failed verification/);
        }
        return;
      }
      assert.equal(command('isolate').status, 'isolated');
      // This is the prepare command that failed on an initialized slot checkout.
      git(repo, 'submodule', 'update', '--init');
      git(repo, 'submodule', 'update', '--init', '--recursive');
      assert.equal(
        command('isolate').status,
        'isolated',
        'prepare replay retains module isolation',
      );
      assert.notEqual(
        spawnSync('git', ['-C', repo, 'cat-file', '-e', reference], { env }).status,
        0,
      );
      modules.forEach((p, i) => {
        assert.equal(git(p, 'rev-parse', 'HEAD'), moduleBases[i]);
        assert.equal(
          readFileSync(path.join(p, 'value.txt'), 'utf8'),
          layout === 'proof' ? 'supplied implementation\n' : 'base\n',
        );
        assert.equal(existsSync(path.join(p, 'answer.txt')), false);
        assert.equal(git(p, 'remote'), '');
        assert.equal(git(p, 'config', 'protocol.allow'), 'never');
        assert.notEqual(
          spawnSync('git', ['-C', p, 'cat-file', '-e', referenceCommits[i]], { env }).status,
          0,
        );
        assert.deepEqual(git(p, 'rev-list', '--all').split('\n'), [moduleBases[i]]);
        if (layout === 'proof') {
          assert.equal(git(p, 'cat-file', '-t', beforeModules[i]), 'commit');
          assert.match(git(p, 'diff', beforeModules[i], moduleBases[i]), /supplied implementation/);
        }
        git(p, 'fsck', '--full', '--no-reflogs');
      });
      if (layout === 'single') {
        assert.equal(command('boundary').status, 'isolated');
        const worker = spawnSync(
          'bash',
          [
            '-c',
            withBlindTrialBoundary(
              [
                `git -C ${q(module)} cat-file -e ${moduleBases[0]}`,
                `! git -C ${q(module)} cat-file -e ${referenceCommits[0]}`,
                `! cat ${q(path.join(spec.capsule, 'state.json'))}`,
                `! git --git-dir=${q(path.join(spec.capsule, 'original.entry/modules/sdk-name'))} cat-file -e ${referenceCommits[0]}`,
              ].join(' && '),
              spec,
            ),
          ],
          { env, encoding: 'utf8', timeout: 10_000 },
        );
        assert.equal(worker.status, 0, worker.stderr);
      }
      writeFileSync(path.join(repo, 'candidate.txt'), 'candidate work\n');
      commit(repo, 'candidate');
      if (layout === 'interrupted') {
        const result = spawnSync(
          'python3',
          [
            '-c',
            `
import json, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name='fixture')
rename = Path.rename
def interrupt(source, target):
    if source.name == 'original.entry':
        raise RuntimeError('fixture interrupted restore')
    return rename(source, target)
Path.rename = interrupt
module['restore'](json.loads(sys.argv[2]))
`,
            new URL('./blind-git.py', import.meta.url).pathname,
            JSON.stringify(spec),
          ],
          { env, encoding: 'utf8', timeout: 60_000 },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /fixture interrupted restore/);
        assert.equal(existsSync(path.join(repo, '.git')), false);
      }
    } finally {
      if (layout === 'preparing') {
        const result = spawnSync(
          'python3',
          [
            '-c',
            `
import json, runpy, sys
module = runpy.run_path(sys.argv[1], run_name='fixture')
def interrupt(state):
    raise RuntimeError('fixture interrupted Git entry restoration')
module['restore'].__globals__['restore_submodule_entries'] = interrupt
module['restore'](json.loads(sys.argv[2]))
`,
            new URL('./blind-git.py', import.meta.url).pathname,
            JSON.stringify(spec),
          ],
          { env, encoding: 'utf8', timeout: 60_000 },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /fixture interrupted Git entry restoration/);
      }
      assert.equal(command('restore').status, 'restored');
      assert.deepEqual(snapshot(path.join(originalDirectory, 'modules')), originalModules);
      modules.forEach((p, i) => {
        assert.deepEqual(
          layout === 'embedded'
            ? snapshot(path.join(p, '.git'))
            : readFileSync(path.join(p, '.git')),
          originalGitfiles[i],
        );
        assert.equal(git(p, 'cat-file', '-t', referenceCommits[i]), 'commit');
      });
    }
  });
}
