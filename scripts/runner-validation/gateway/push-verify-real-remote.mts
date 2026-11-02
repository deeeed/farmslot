// Read-only proof of push verification against the real private GitHub remote,
// over the SSH URL slot clones use (F326, Terminal #298). A temporary clone that
// fetches main only gets an already pushed branch explicitly, plus a stale
// origin/<branch> ref one commit behind. This checkout's push inspection must
// read 0 unpushed with the remote checked; the base ref's inspection must read
// more than 0 on the same clone. Nothing is pushed and no remote ref is changed.
//
//   TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
//     scripts/runner-validation/gateway/push-verify-real-remote.mts \
//     [--remote git@github.com:deeeed/farmslot.git] [--branch <pushed branch>] [--base origin/main]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { ExecResult } from '@farmslot/protocol';

const { remote, branch, base } = parseArgs({
  options: {
    remote: { type: 'string', default: 'git@github.com:deeeed/farmslot.git' },
    branch: { type: 'string', default: 'fix/push-verify-against-remote' },
    base: { type: 'string', default: 'origin/main' },
  },
}).values;

const checkout = path.resolve(import.meta.dirname, '../../..');
const moduleDir = path.join(checkout, 'services/gateway/src/run-engine');
const root = mkdtempSync(path.join(os.tmpdir(), 'push-verify-real-remote-'));
const clone = path.join(root, 'clone');
// The base module sits beside the current one so its relative imports resolve.
const baseModule = path.join(moduleDir, `push-verification.base-proof-${process.pid}.ts`);
const cleanup = () => {
  rmSync(root, { recursive: true, force: true });
  rmSync(baseModule, { force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => process.exit(1));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

// A main-only clone, as `+refs/heads/main:refs/remotes/origin/main` slots have.
git(
  root,
  'clone',
  '--quiet',
  '--filter=blob:none',
  '--no-checkout',
  '--single-branch',
  '--branch',
  'main',
  '--no-tags',
  remote,
  clone,
);
const fetchRefspecs = git(clone, 'config', '--get-all', 'remote.origin.fetch');
assert.equal(fetchRefspecs, '+refs/heads/main:refs/remotes/origin/main');
git(clone, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`);
const tip = git(clone, 'rev-parse', `refs/heads/${branch}`);
const stale = git(clone, 'rev-parse', `refs/heads/${branch}~1`);
git(clone, 'update-ref', `refs/remotes/origin/${branch}`, stale);
// Check out one file so the worktree is clean without downloading every blob.
git(clone, 'sparse-checkout', 'set', '--no-cone', '/package.json');
git(clone, 'checkout', '--quiet', branch);

const { execFileArgv, execLocal } = await import('../../../services/gateway/src/core/exec.js');
// Production local exec (bash), and the zsh a macOS node runs commands with.
const shells: Record<string, (command: string) => Promise<ExecResult>> = {
  bash: (command) => execLocal(command, { cwd: clone, timeout: 30_000 }),
  zsh: (command) => execFileArgv(['zsh', '-f', '-c', command], { cwd: clone, timeout: 30_000 }),
};
type Inspect = typeof import('../../../services/gateway/src/run-engine/push-verification.js');

async function inspectAll(module: Inspect) {
  const states: Record<string, Awaited<ReturnType<Inspect['inspectWorktreePublishState']>>> = {};
  for (const [shell, execute] of Object.entries(shells)) {
    const started = Date.now();
    states[shell] = await module.inspectWorktreePublishState(branch, 'push', execute);
    console.log(`${shell}: ${JSON.stringify(states[shell])} in ${Date.now() - started} ms`);
  }
  return states;
}

console.log(
  JSON.stringify({ remote, fetchRefspecs, branch, tip, staleOriginRef: stale, clone }, null, 2),
);
console.log(`\nfixed (${git(checkout, 'rev-parse', 'HEAD')}):`);
const fixed = await inspectAll(
  await import('../../../services/gateway/src/run-engine/push-verification.js'),
);
for (const state of Object.values(fixed)) {
  assert.equal(state.unpushedCommits, 0);
  assert.equal(state.remoteChecked, true);
  assert.equal(state.dirtyFiles, 0);
}

const baseSha = git(checkout, 'rev-parse', base);
writeFileSync(
  baseModule,
  git(checkout, 'show', `${baseSha}:services/gateway/src/run-engine/push-verification.ts`),
);
console.log(`\nbase ${base} (${baseSha}):`);
const before = await inspectAll((await import(pathToFileURL(baseModule).href)) as Inspect);
for (const state of Object.values(before)) assert.ok(state.unpushedCommits > 0);

console.log(
  '\nPASS: the fixed inspection reads the pushed branch as published; the base blocks it.',
);
