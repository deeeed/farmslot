// Opt-in production-RPC proof. Real Git/SSH signatures and disposable state;
// only the PTY transport is substituted. No product slot, model or tmux server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { SlotPrepareResult } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import { createNativeProofFixture } from '../../runtime/native-proof-fixture.live-support.js';

test(
  'prepare refuses unavailable worker-session signing before modifying refs',
  { timeout: 120_000 },
  async (t) => {
    const out = process.env.FARMSLOT_SIGNING_PROOF_OUT;
    assert.ok(out, 'set an owned receipt directory');
    await mkdir(out, { recursive: true });
    const root = await mkdtemp('/tmp/signing-rpc-');
    for (const key of Object.keys(process.env))
      if (/^(FARMSLOT_|GIT_CONFIG|TMUX)/.test(key)) delete process.env[key];
    process.env.FARMSLOT_HOME = path.join(root, 'home');
    process.env.FARMSLOT_ROOT = root;
    process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
    process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
    process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const repo = path.join(root, 'repo');
    for (const directory of [
      'repo',
      'home',
      'pool',
      'projects/proof',
      'services/gateway',
      'scripts',
      'bin',
    ])
      await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable signing proof\n');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    await writeFile(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = path.join(root, 'bin') + ':' + process.env.PATH;
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'feature');
    git('config', 'user.name', 'Signing proof');
    git('config', 'user.email', 'proof@example.invalid');
    git('config', 'core.hooksPath', '/dev/null');
    git('config', 'commit.gpgsign', 'false');
    git('commit', '-q', '--allow-empty', '-m', 'test: trusted base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const before = git('rev-parse', 'HEAD');
    const key = path.join(root, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const signer = path.join(root, 'signer');
    await writeFile(
      signer,
      `#!/bin/sh\nif [ "$WORKER_SIGNING_CONTEXT" = unavailable ]; then echo 'agent unavailable in worker session' >&2; exit 1; fi\nexec ssh-keygen "$@"\n`,
      { mode: 0o755 },
    );
    git('config', 'gpg.ssh.program', signer);
    await writeFile(
      path.join(root, 'home/git-identity.json'),
      JSON.stringify({
        'user.name': 'Signing proof',
        'user.email': 'proof@example.invalid',
        'commit.gpgsign': 'true',
        'gpg.format': 'ssh',
        'user.signingkey': key,
      }),
    );
    await writeFile(
      path.join(root, 'pool/fixture.json'),
      JSON.stringify({
        machine: hostname(),
        host: 'localhost',
        project: 'proof',
        platform: 'cli',
        slots: [{ id: 'signing-slot', repo, session: 'signing-proof' }],
      }),
    );
    await writeFile(
      path.join(root, 'projects/proof/project.json'),
      JSON.stringify({
        name: 'proof',
        default_branch: 'main',
        paths: { runtime_dir: '.agent' },
        prepare: { profiles: { probe: { phases: ['health'] } } },
      }),
    );
    const execution = await import('../../core/exec.js');
    const executeOnSlot: typeof execution.execOnSlot = async (...args) =>
      /\btmux\b/.test(args[1])
        ? { exitCode: 0, stdout: '', stderr: '' }
        : execution.execOnSlot(...args);
    mock.module('../../core/exec.js', {
      namedExports: { ...execution, execOnSlot: executeOnSlot },
    });
    const core = await import('../../core/index.js');
    mock.module('../../core/index.js', { namedExports: { ...core, execOnSlot: executeOnSlot } });
    const tmux = await import('../../core/tmux.js');
    mock.module('../../core/tmux.js', {
      namedExports: { ...tmux, resolveTmuxSession: async () => 'signing-proof' },
    });
    const prepare = await import('./prepare-command.js');
    const calls: string[] = [];
    let workerReady = false;
    mock.module('./prepare-command.js', {
      namedExports: {
        ...prepare,
        runPrepareCommand: async (
          vars: { remoteRepo: string },
          _log: string,
          command: string,
          options: { phase: string },
        ) => {
          assert.equal(options.phase, 'signing');
          calls.push(options.phase);
          return execution.execLocal(
            `export WORKER_SIGNING_CONTEXT=${workerReady ? 'ready' : 'unavailable'}; ${command}`,
            { cwd: vars.remoteRepo, timeout: 20_000 },
          );
        },
      },
    });
    const fixture = await createNativeProofFixture(t, root);
    await assert.rejects(
      fixture.client.call('slot.prepare', { slotId: 'signing-slot', prepareProfile: 'probe' }),
      /Commit signing is not ready.*agent unavailable/,
    );
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(git('branch', '--show-current'), 'feature');
    workerReady = true;
    const ready = await fixture.client.call<SlotPrepareResult>('slot.prepare', {
      slotId: 'signing-slot',
      prepareProfile: 'probe',
    });
    assert.equal(ready.prepared, true);
    assert.deepEqual(calls, ['signing', 'signing']);
    assert.equal(git('rev-parse', 'HEAD'), before);
    const { assertCommitSignatures } = await import('../../run-completion/commit-signatures.js');
    const { loadSlotVars } = await import('../../core/config.js');
    const vars = await loadSlotVars('signing-slot');
    const unsigned = git(
      'commit-tree',
      git('rev-parse', 'HEAD^{tree}'),
      '-p',
      before,
      '-m',
      'test: rewritten subject',
    );
    git('update-ref', 'HEAD', unsigned);
    git('commit', '-q', '--allow-empty', '-m', 'test: later signed commit');
    await assert.rejects(
      assertCommitSignatures(vars, 'refs/remotes/origin/main'),
      /Unsigned outgoing commit/,
    );
    const signed = git(
      'commit-tree',
      '-S',
      git('rev-parse', 'HEAD^{tree}'),
      '-p',
      before,
      '-m',
      'test: signed contribution',
    );
    git('update-ref', 'HEAD', signed);
    await assertCommitSignatures(vars, 'refs/remotes/origin/main');
    await writeFile(
      path.join(out, 'signing-rpc.json'),
      JSON.stringify(
        {
          publicRpc: 'slot.prepare',
          unavailableRefused: true,
          healthyPassed: true,
          refsPreserved: true,
          unsignedContributionRefused: unsigned,
          signedContributionAccepted: signed,
          scope:
            'production RPC prepare and real Git; PTY transport substituted, no real worker/agent health claim',
        },
        null,
        2,
      ) + '\n',
    );
  },
);
