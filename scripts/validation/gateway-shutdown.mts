// Manual full-startup proof, outside the default test suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gatewayPresenceDirectory } from '@farmslot/credential-store';

import { testGatewayIdentity } from '../lib/test-gateway-identity.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'credential-shutdown-proof-'));
const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    const path = join(scratch, marker);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, marker.endsWith('json') ? '{}' : '');
  }
  await mkdir(join(scratch, 'pool'));
  await mkdir(join(scratch, 'projects'));
  await mkdir(join(scratch, 'bin'));
  // Authentication/startup proof never needs a terminal server.
  await writeFile(join(scratch, 'bin/tmux'), '#!/bin/sh\nexit 77\n', { mode: 0o700 });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const env = {
      ...process.env,
      PATH: `${join(scratch, 'bin')}:${process.env.PATH}`,
      FARMSLOT_ROOT: scratch,
      FARMSLOT_HOME: join(scratch, signal),
      FARMSLOT_POOL_DIR: join(scratch, 'pool'),
      FARMSLOT_PROJECTS_DIR: join(scratch, 'projects'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: '0',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DEMO_POOL: '0',
      FARMSLOT_LOCAL_HEALTH_POLL: '0',
      FARMSLOT_RESOURCE_POLL_ALL: '0',
      FARMSLOT_STARTUP_BRANCH_PREWARM: '0',
    };
    testGatewayIdentity(env.FARMSLOT_HOME);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(root, 'services/gateway'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    try {
      const presence = gatewayPresenceDirectory(env);
      const deadline = Date.now() + 30_000;
      while (!existsSync(presence)) {
        if (child.exitCode !== null) throw new Error(`Gateway exited before presence: ${output}`);
        assert.ok(Date.now() < deadline, `Gateway presence timed out: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // The presence directory can survive removal; use the actual live marker.
      const { readdir } = await import('node:fs/promises');
      while ((await readdir(presence)).length === 0) {
        if (child.exitCode !== null)
          throw new Error(`Gateway exited before registration: ${output}`);
        assert.ok(Date.now() < deadline, `Gateway registration timed out: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(child.kill(signal));
      const [code] = await exit;
      assert.equal(code, signal === 'SIGINT' ? 130 : 143, output);
      assert.equal(existsSync(presence) ? (await readdir(presence)).length : 0, 0);
      console.log(JSON.stringify({ signal, code, presenceRemoved: true }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exit;
      }
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
