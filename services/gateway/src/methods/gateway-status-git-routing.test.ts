// Routing proof: gateway-status git() calls route through gitService.run, not direct execFile.
// This test fails when gateway-status.ts uses child_process directly instead of gitService.run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import * as realCore from '../core/index.js';
import type { GitRunOptions } from '../host-services/git.js';
import * as realGit from '../host-services/git.js';

import type { CheckoutObservationChange } from './gateway-update.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'gw-status-git-routing-'));
const gitCmd = (...args: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
gitCmd('init', '-q', '-b', 'main');
gitCmd('commit', '-q', '--allow-empty', '-m', 'init');

const gitRunCalls: string[][] = [];

mock.module('../core/index.js', {
  namedExports: {
    ...realCore,
    farmslotRoot: () => root,
  },
});

mock.module('../host-services/git.js', {
  namedExports: {
    ...realGit,
    gitService: {
      ...realGit.gitService,
      run(argv: string[], options?: GitRunOptions) {
        gitRunCalls.push(argv);
        return realGit.gitService.run(argv, options);
      },
    },
  },
});

// Stub out file-watcher and checkout-update reader so the test has no chokidar side-effects.
mock.module('./gateway-update.js', {
  namedExports: {
    readCheckoutUpdate: async () => undefined,
    watchCheckoutUpdateChanges:
      async (
        _onChange: (kind: CheckoutObservationChange) => void,
        _onError: (error: unknown) => void,
      ): Promise<() => Promise<void>> =>
      async () => {},
  },
});

const { startGatewayUpdateObservation } = await import('./gateway-status.js');

test.after(() => rm(root, { recursive: true, force: true }));

test('gateway-status git() routes git operations through gitService.run', async () => {
  // startGatewayUpdateObservation awaits refreshInstalled('checkout') before resolving.
  // refreshInstalled → readInstalledCheckout → originHead + git('rev-parse') → gitService.run.
  const stop = await startGatewayUpdateObservation({ hasInterest: () => true });
  try {
    assert.ok(
      gitRunCalls.length > 0,
      'gitService.run was never called — gateway-status may be using execFile directly',
    );
    assert.ok(
      gitRunCalls.some((argv) => argv.includes('rev-parse') || argv.includes('symbolic-ref')),
      `expected rev-parse or symbolic-ref via gitService.run; calls: ${JSON.stringify(gitRunCalls)}`,
    );
  } finally {
    await stop();
  }
});
