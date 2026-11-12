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
  'dirty',
  'dirty-nested',
  'untracked-nested',
  'missing-cache',
  'candidate',
  'candidate-nested',
  'candidate-linked',
  'candidate-embedded',
  'candidate-interrupted',
  'candidate-reconnected',
  'candidate-export-interrupted',
  'candidate-legacy-retry',
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
    const commit = (repo: string, message: string, stage = true) => {
      if (stage) git(repo, 'add', '.');
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
    const nested = ['nested', 'dirty-nested', 'untracked-nested', 'candidate-nested'].includes(
      layout,
    );
    const embedded = layout === 'embedded' || layout === 'candidate-embedded';
    const candidate = layout.startsWith('candidate');
    if (nested) {
      add(upstream, init('leaf-upstream'), 'leaf-name', 'deps/leaf');
      commit(upstream, 'nested dependency');
    }
    const source = init('source');
    const linked = layout === 'linked' || layout === 'preparing' || layout === 'candidate-linked';
    const repo = linked ? path.join(root, 'linked') : source;
    if (linked) git(source, 'worktree', 'add', '-q', '--detach', repo);
    add(repo, upstream, 'sdk-name', 'deps/sdk');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
    let comparisonBase = commit(repo, 'dependency base');
    const module = path.join(repo, 'deps/sdk');
    const modules = [module];
    if (nested) modules.unshift(path.join(module, 'deps/leaf'));
    const beforeModules = modules.map((p) => git(p, 'rev-parse', 'HEAD'));
    let missingCommit: string | undefined;
    if (layout === 'missing-cache') {
      writeFileSync(path.join(upstream, 'value.txt'), 'uncached historical snapshot\n');
      missingCommit = commit(upstream, 'uncached module');
      git(repo, 'update-index', '--cacheinfo', '160000', missingCommit, 'deps/sdk');
      comparisonBase = commit(repo, 'historical gitlink absent from cache', false);
      git(repo, 'update-index', '--cacheinfo', '160000', beforeModules[0], 'deps/sdk');
      commit(repo, 'cached current gitlink', false);
    }
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
    if (embedded) {
      const directory = git(module, 'rev-parse', '--absolute-git-dir');
      rmSync(path.join(module, '.git'));
      renameSync(directory, path.join(module, '.git'));
      git(module, 'config', '--unset', 'core.worktree');
    }
    if (candidate) modules.forEach((p) => git(p, 'config', 'core.logAllRefUpdates', 'always'));
    const moduleDirectories = modules.map((p) => git(p, 'rev-parse', '--absolute-git-dir'));
    const metadata = (directory: string) =>
      Object.fromEntries(
        Object.entries(snapshot(directory)).filter(([name]) => !name.startsWith('modules/')),
      );
    const originalMetadata = moduleDirectories.map(metadata);
    const candidateCommits: string[][] = modules.map(() => []);
    let candidateHead: string | undefined;
    const originalModules = snapshot(path.join(originalDirectory, 'modules'));
    const originalGitfiles = modules.map((p) =>
      embedded ? snapshot(path.join(p, '.git')) : readFileSync(path.join(p, '.git')),
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
      ...(['proof', 'missing-cache'].includes(layout)
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
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    if (['dirty', 'dirty-nested', 'untracked-nested'].includes(layout)) {
      for (const parent of [repo, ...(nested ? [module] : [])]) {
        git(
          parent,
          'config',
          '-f',
          '.gitmodules',
          'submodule.' + (parent === repo ? 'sdk-name' : 'leaf-name') + '.ignore',
          'dirty',
        );
        commit(parent, 'ignore dirty module');
        if (layout !== 'dirty')
          git(
            parent,
            'config',
            'submodule.' + (parent === repo ? 'sdk-name' : 'leaf-name') + '.ignore',
            'all',
          );
      }
      // Record the changed parent gitlink, then hide only the local edit.
      if (nested) commit(repo, 'updated nested config');
      const dirtyFile = path.join(
        modules[0],
        layout === 'untracked-nested' ? 'untracked.txt' : 'value.txt',
      );
      writeFileSync(dirtyFile, 'local work must survive\n');
      if (layout === 'untracked-nested')
        git(modules[0], 'config', 'status.showUntrackedFiles', 'no');
      assert.equal(git(repo, 'status', '--porcelain'), '');
      const before = moduleDirectories.map(snapshot);
      const originalEntry = snapshot(originalDirectory);
      assert.throws(
        () => command('isolate'),
        (error: Error) => {
          assert.match(error.message, /dirty submodule/i);
          assert.ok(error.message.includes(path.relative(repo, modules[0])));
          return true;
        },
      );
      assert.equal(readFileSync(dirtyFile, 'utf8'), 'local work must survive\n');
      assert.deepEqual(snapshot(originalDirectory), originalEntry);
      moduleDirectories.forEach((directory, i) => assert.deepEqual(snapshot(directory), before[i]));
      assert.equal(existsSync(spec.capsule), false, 'refuse before any mutation');
      return;
    }
    try {
      if (layout === 'missing-cache') {
        assert.throws(
          () => command('isolate'),
          (error: Error) => {
            assert.match(error.message, /deps\/sdk.*missing admitted commit/);
            assert.ok(error.message.includes(missingCommit!));
            assert.match(error.message, /populate that module cache before isolation/);
            return true;
          },
        );
        return;
      }
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
      if (candidate) {
        modules.forEach((p, i) => {
          writeFileSync(path.join(p, 'value.txt'), 'candidate module work\n');
          candidateCommits[i].push(commit(p, 'candidate module'));
        });
        // Preserve a gitlink from earlier candidate history, even after its module
        // branch and HEAD move away. Also retain a ref outside the recorded gitlink.
        commit(repo, 'record candidate modules');
        modules.forEach((p, i) => {
          git(p, 'checkout', '--detach', moduleBases[i]);
          writeFileSync(path.join(p, 'side.txt'), 'candidate side branch\n');
          const side = commit(p, 'candidate side branch');
          candidateCommits[i].push(side);
          git(p, 'update-ref', 'refs/heads/side', side);
          git(p, 'checkout', '--detach', moduleBases[i]);
          writeFileSync(path.join(p, 'head.txt'), 'candidate module head\n');
          candidateCommits[i].push(commit(p, 'candidate module head'));
        });
      }
      writeFileSync(path.join(repo, 'candidate.txt'), 'candidate work\n');
      candidateHead = commit(repo, 'candidate');
      if (candidate) {
        modules.forEach((p, i) => {
          // HEAD can also contain work that no recorded gitlink or branch retains.
          writeFileSync(path.join(p, 'head-only.txt'), 'unrecorded candidate head\n');
          candidateCommits[i].push(commit(p, 'unrecorded module head'));
        });
      }
      if (
        [
          'interrupted',
          'candidate-interrupted',
          'candidate-reconnected',
          'candidate-export-interrupted',
          'candidate-legacy-retry',
        ].includes(layout)
      ) {
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
    if sys.argv[3] == 'candidate-interrupted' or sys.argv[3] == 'interrupted':
        stop = source.name == 'original.entry'
    else:
        stop = False
    if stop:
        raise RuntimeError('fixture interrupted restore')
    return rename(source, target)
Path.rename = interrupt
if sys.argv[3] in ['candidate-reconnected', 'candidate-legacy-retry']:
    if sys.argv[3] == 'candidate-legacy-retry':
        module['restore'].__globals__['preserve_submodule_candidates'] = lambda *args: None
    def reject(state):
        if sys.argv[3] == 'candidate-legacy-retry':
            state.pop('submodulesExported', None)
            for item in state['submodules']:
                item.pop('originalDirectory', None)
            module['save'](Path(state['capsule']) / 'state.json', state)
        raise RuntimeError('fixture interrupted restore')
    module['restore'].__globals__['restore_submodule_entries'] = reject
if sys.argv[3] == 'candidate-export-interrupted':
    pack = module['pack_into']
    def reject(*args, **kwargs):
        pack(*args, **kwargs)
        if Path(args[1]).name == 'sdk-name':
            raise RuntimeError('fixture interrupted restore')
    module['restore'].__globals__['pack_into'] = reject
module['restore'](json.loads(sys.argv[2]))
`,
            new URL('./blind-git.py', import.meta.url).pathname,
            JSON.stringify(spec),
            layout,
          ],
          { env, encoding: 'utf8', timeout: 60_000 },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /fixture interrupted restore/);
        if (layout === 'interrupted' || layout === 'candidate-interrupted') {
          assert.equal(existsSync(path.join(repo, '.git')), false);
        }
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
      if (!candidate) {
        assert.deepEqual(snapshot(path.join(originalDirectory, 'modules')), originalModules);
      } else {
        assert.equal(git(repo, 'rev-parse', spec.branch), candidateHead);
        modules.forEach((p, i) => {
          const directory = moduleDirectories[i];
          const after = metadata(directory);
          const additions = Object.keys(after).filter((name) => !(name in originalMetadata[i]));
          assert.ok(additions.length > 0);
          for (const name of additions) {
            assert.match(name, /^(objects\/|refs\/farmslot\/candidate\/)/);
            delete after[name];
          }
          assert.deepEqual(
            after,
            originalMetadata[i],
            'original metadata bytes and modes are unchanged',
          );
          const preserved = git(
            p,
            'for-each-ref',
            '--format=%(objectname)',
            'refs/farmslot/candidate/',
          ).split('\n');
          for (const sha of candidateCommits[i]) {
            assert.equal(git(p, 'cat-file', '-t', sha), 'commit');
            assert.ok(preserved.includes(sha), 'retain each candidate root with a ref');
          }
          const parent = i === modules.length - 1 ? repo : module;
          const parentHead = i === modules.length - 1 ? candidateHead! : candidateCommits[i + 1][0];
          const gitlink = git(parent, 'ls-tree', parentHead, path.relative(parent, p)).split(
            /\s+/,
          )[2];
          assert.equal(git(p, 'cat-file', '-t', gitlink), 'commit');
        });
      }
      modules.forEach((p, i) => {
        if (!(candidate && embedded))
          assert.deepEqual(
            embedded ? snapshot(path.join(p, '.git')) : readFileSync(path.join(p, '.git')),
            originalGitfiles[i],
          );
        assert.equal(git(p, 'cat-file', '-t', referenceCommits[i]), 'commit');
      });
    }
  });
}
