import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { makeVars } from '../runners/test-fixtures.js';
const execute = promisify(execFile);
const actualExec = await import('../core/exec.js');
let environment: NodeJS.ProcessEnv;
mock.module('../core/exec.js', {
  namedExports: {
    ...actualExec,
    isLocal: () => false,
    execOnSlot: async (_vars: unknown, command: string) => {
      try {
        return {
          ...(await execute('bash', ['-c', command], { env: environment, encoding: 'utf8' })),
          exitCode: 0,
        };
      } catch {
        return { stdout: '', stderr: 'slot not found in node pool', exitCode: 1 };
      }
    },
  },
});
const { extractRunnerSessionUsage } = await import('./session-usage.js');

test('remote forced-path accounting bypasses an older node wrapper and requires no local slot pool', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poolless-worker-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'cli');
  for (const dir of ['bin', 'node_modules/@farmslot/slot-config'])
    await mkdir(path.join(cli, dir), { recursive: true });
  await writeFile(path.join(cli, 'bin/farmslot'), '#!/bin/false\n', { mode: 0o755 });
  await writeFile(
    path.join(cli, 'node_modules/@farmslot/slot-config/package.json'),
    JSON.stringify({ type: 'module', exports: './session-usage.ts' }),
  );
  await symlink(
    fileURLToPath(
      new URL('../../../../packages/slot-config/src/session-usage.ts', import.meta.url),
    ),
    path.join(cli, 'node_modules/@farmslot/slot-config/session-usage.ts'),
  );
  const scripts = path.join(root, 'farmslot-node/scripts');
  await mkdir(scripts, { recursive: true });
  const marker = path.join(root, 'old-wrapper-called');
  await writeFile(
    path.join(scripts, 'session-usage.sh'),
    `touch '${marker}'\necho 'slot not found in node pool' >&2\nexit 1\n`,
  );
  environment = {
    ...process.env,
    HOME: root,
    PATH: path.join(cli, 'bin') + path.delimiter + process.env.PATH,
    FARMSLOT_POOL_DIR: path.join(root, 'no-pool'),
  };
  const transcript = path.join(root, 'worker.jsonl');
  await writeFile(
    transcript,
    [
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const usage = await extractRunnerSessionUsage({
    slotId: 'missing-slot',
    vars: makeVars({ host: 'worker.invalid', machine: 'worker-node' }),
    runner: 'codex',
    runnerSessionId: 'worker',
    runnerSessionPath: transcript,
  });
  assert.equal(usage.source, 'runner-transcript');
  assert.equal(usage.totalTokens, 30);
  assert.equal(usage.costUsd, null);
  assert.equal(existsSync(marker), false);
});
