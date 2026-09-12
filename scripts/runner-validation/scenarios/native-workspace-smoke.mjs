import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-workspace-smoke';

function rpc(method, params = {}, token = process.env.FARMSLOT_GATEWAY_TOKEN) {
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FARMSLOT_GATEWAY_TOKEN: token },
          timeout: 60_000,
        },
      ),
    );
  } catch (error) {
    throw Object.assign(new Error(`Gateway ${method} failed`), {
      rpcCode: String(error.stderr ?? '').match(/"code":"([A-Z_]+)"/)?.[1],
    });
  }
}

export async function runScenario({ runnerAdapter, outDir }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  let session;
  let root;
  try {
    assert.equal(
      process.env.FARMSLOT_GATEWAY,
      'ws://127.0.0.1:18777',
      'Use the isolated validation gateway',
    );
    const other = process.env.FARMSLOT_NATIVE_OTHER_TOKEN;
    assert.ok(
      other && other !== process.env.FARMSLOT_GATEWAY_TOKEN,
      'Supply a second authenticated principal',
    );
    rpc('principal.list', {}, other);
    const catalog = rpc('native.session.catalog');
    assert.ok(catalog.runners.some((option) => option.runner === report.runner));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-workspace-live-'));
    const cwd = path.join(root, 'nested');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside workspace\n');
    fs.writeFileSync(path.join(cwd, 'safe.ts'), 'before\n');
    fs.writeFileSync(path.join(cwd, '*.ts'), 'literal before\n');
    const gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const git = (...args) => execFileSync('git', args, { cwd: root, env: gitEnv, stdio: 'pipe' });
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Validation Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'test: initialize workspace fixture',
    );
    fs.writeFileSync(path.join(cwd, 'safe.ts'), 'after\n');
    fs.writeFileSync(path.join(cwd, '*.ts'), 'literal after\n');
    fs.writeFileSync(path.join(cwd, ':new.ts'), 'untracked\n');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside changed\n');
    fs.writeFileSync(path.join(cwd, 'binary'), Buffer.from([0, 1]));
    fs.writeFileSync(path.join(cwd, 'large'), Buffer.alloc(1024 * 1024 + 1, 'x'));
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(cwd, 'escape'));
    session = rpc('native.session.create', { runner: report.runner, cwd }).session;
    const target = { sessionId: session.id };
    assert.equal(
      rpc('native.session.workspace.read', { ...target, path: 'safe.ts' }).content,
      'after\n',
    );
    const files = rpc('native.session.workspace.changes', target).files;
    assert.ok(files.some((file) => file.path === 'safe.ts'));
    assert.ok(files.some((file) => file.path === '*.ts'));
    assert.ok(
      !files.some((file) => file.path.includes('outside.txt') || file.path.startsWith('nested/')),
    );
    const diff = rpc('native.session.workspace.diff', { ...target, path: '*.ts' }).diff;
    assert.match(diff, /literal after/);
    assert.doesNotMatch(diff, /safe\.ts|outside/);
    assert.match(
      rpc('native.session.workspace.diff', { ...target, path: ':new.ts' }).diff,
      /\+untracked/,
    );
    report.checks.push(
      'source, tracked/untracked diffs and literal filenames remain relative to the session subdirectory',
    );
    for (const file of [
      '../outside.txt',
      '/etc/hosts',
      '.git/config',
      'escape',
      'binary',
      'large',
    ]) {
      assert.throws(
        () => rpc('native.session.workspace.read', { ...target, path: file }),
        (error) => error.rpcCode === 'NATIVE_SESSION_ERROR',
        `${file} must be rejected by the gateway`,
      );
    }
    const listing = rpc('native.session.workspace.list', { ...target, path: '.' });
    assert.ok(!listing.entries.some((entry) => entry.name === 'escape' || entry.name === '.git'));
    report.checks.push(
      'real RPC rejects traversal, absolute paths, Git metadata, symlinks, binary and oversized source',
    );
    for (const method of [
      'native.session.catalog',
      'native.session.workspace.list',
      'native.session.workspace.read',
      'native.session.workspace.changes',
      'native.session.workspace.diff',
    ]) {
      assert.throws(
        () => rpc(method, { ...target, path: 'safe.ts' }, other),
        (error) => error.rpcCode === 'AUTH_FORBIDDEN',
      );
    }
    assert.equal(rpc('native.session.read', target).session.state, 'idle');
    report.checks.push(
      'another authenticated administrator cannot access catalog or session workspace',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (session) {
      try {
        rpc('native.session.close', { sessionId: session.id });
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
    }
    if (root && !report.cleanupError) fs.rmSync(root, { recursive: true, force: true });
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, outPath, pass: report.pass, report };
}
