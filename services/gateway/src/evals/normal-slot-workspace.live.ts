import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EVAL_PRIOR_WORK_DIRECTORY } from '@farmslot/protocol/node/farm-paths';

import { type BlindGitSpec, buildBlindGitCommand } from './blind-git.js';

test('normal-slot prepare parks earlier answer files while retaining this task and caches', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'normal-eval-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(
    path.join(repo, '.gitignore'),
    'temp/\nnode_modules/\n.env.local\n.farmslot-instance/\n',
  );
  writeFileSync(path.join(repo, 'source.txt'), 'before fix\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: before fix',
  );
  const baseSha = git('rev-parse', 'HEAD');
  const config = readFileSync(path.join(repo, '.git/config'), 'utf8');
  const inputs = {
    'temp/recipe/runtime/service-fix.patch': '+prior answer\n',
    'temp/tasks/fix/eval-earlier/artifacts/recipe-quality.json': '{"answer":"prior fix"}\n',
    'temp/tasks/fix/current/inputs/candidate-template.md': 'frozen candidate bytes\n',
    'temp/tasks/fix/current/TASK.md': 'neutral problem\n',
    'node_modules/tool/index.js': 'cached dependency\n',
    '.env.local': 'local setup\n',
    '.farmslot-instance/owner': 'current farm\n',
    'temp/recipe/runtime/.preparing.lock/owner': 'current prepare\n',
  };
  for (const [name, content] of Object.entries(inputs)) {
    const file = path.join(repo, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const spec: BlindGitSpec = {
    repo,
    slotId: 'fixture-slot',
    runId: 'fixture-trial',
    slotEpoch: 1,
    branch: 'eval/current',
    baseSha,
    referenceCommits: [],
    capsule: path.join(root, 'must-not-exist'),
    keepIgnored: ['node_modules', 'temp/tasks/fix/current', 'temp/recipe/runtime/.preparing.lock'],
    cleanupRoots: ['temp/tasks', 'temp/recipe/runtime'],
    priorWorkDirectory: EVAL_PRIOR_WORK_DIRECTORY,
  };
  const receipt = JSON.parse(
    execFileSync('bash', ['-c', buildBlindGitCommand('park-ignored', spec)], { encoding: 'utf8' }),
  );
  assert.equal(receipt.status, 'parked-ignored');
  for (const [name, content] of Object.entries(inputs).slice(0, 2)) {
    assert.equal(existsSync(path.join(repo, name)), false, `earlier answer removed: ${name}`);
    const parked = path.join(receipt.parkingPath, name);
    assert.equal(readFileSync(parked, 'utf8'), content);
  }
  // A crash before the gateway persists its receipt may leave new prepare logs.
  const retryLog = path.join(repo, 'temp/recipe/runtime/prepare.log');
  mkdirSync(path.dirname(retryLog), { recursive: true });
  writeFileSync(retryLog, 'retry prepare log');
  const retryReceipt = JSON.parse(
    execFileSync('bash', ['-c', buildBlindGitCommand('park-ignored', spec)], { encoding: 'utf8' }),
  );
  assert.notEqual(retryReceipt.parkingPath, receipt.parkingPath);
  assert.equal(existsSync(retryLog), false);
  assert.equal(
    readFileSync(path.join(receipt.parkingPath, 'temp/recipe/runtime/service-fix.patch'), 'utf8'),
    inputs['temp/recipe/runtime/service-fix.patch'],
  );
  for (const [name, content] of Object.entries(inputs).slice(2))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), content);
  assert.equal(git('rev-parse', 'HEAD'), baseSha);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(readFileSync(path.join(repo, '.git/config'), 'utf8'), config);
  assert.equal(existsSync(spec.capsule), false);
  assert.equal(existsSync(path.join(root, '.farmslot-blind-evals')), false);
});
