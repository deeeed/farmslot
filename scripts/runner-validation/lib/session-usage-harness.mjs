import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, sleepMs } from './common.mjs';

const SCRIPT_PATH = path.join(ROOT, 'scripts/session-usage.sh');
const SLOT_ID = 'runner-validate-slot';

/** Minimal pool slot so session-usage.sh can resolve repo — mirrors session-usage-script.test.ts */
export function makeUsagePoolHarness(repoDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-usage-'));
  const poolDir = path.join(root, 'pool');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(
    path.join(poolDir, 'local.json'),
    JSON.stringify({
      schema_version: 1,
      machine: 'runner-validate',
      project: 'test-project',
      platform: 'test',
      os: 'darwin',
      host: 'localhost',
      ssh_user: process.env.USER || 'tester',
      slots: [
        {
          id: SLOT_ID,
          enabled: true,
          repo: repoDir,
          session: SLOT_ID,
          resources: {},
        },
      ],
    }),
  );
  return { root, poolDir, slotId: SLOT_ID };
}

export function runSessionUsageTotal({ runner, sessionPath, poolDir, home = os.homedir() }) {
  return execFileSync('bash', [SCRIPT_PATH, SLOT_ID, 'total'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      FARMSLOT_POOL_DIR: poolDir,
      RUNNER_SESSION_RUNNER: runner,
      RUNNER_SESSION_PATH: sessionPath,
    },
  });
}

export function parseSessionUsageStdout(stdout) {
  const lineNum = (prefix) => {
    const line = stdout.split('\n').find((entry) => entry.startsWith(prefix));
    if (!line) return null;
    const n = Number.parseFloat(line.slice(prefix.length));
    return Number.isFinite(n) ? n : null;
  };
  const lineStr = (prefix) => {
    const line = stdout.split('\n').find((entry) => entry.startsWith(prefix));
    if (!line) return null;
    const value = line.slice(prefix.length).trim();
    return value && value !== 'unknown' ? value : null;
  };
  return {
    turns: lineNum('turns='),
    model: lineStr('model='),
    input_tokens: lineNum('input_tokens='),
    output_tokens: lineNum('output_tokens='),
    cache_creation: lineNum('cache_creation='),
    cache_read: lineNum('cache_read='),
    reasoning_output_tokens: lineNum('reasoning_output_tokens='),
    total_tokens: lineNum('total_tokens='),
    cost_usd: lineNum('cost_usd='),
  };
}

export function usageExtractedOk(usage) {
  return (usage.turns ?? 0) >= 1 && (usage.total_tokens ?? 0) > 0;
}

export function pollSessionUsageFromScript(
  runner,
  sessionPath,
  poolDir,
  { timeoutMs = 30_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let stdout = '';
  while (Date.now() < deadline) {
    stdout = runSessionUsageTotal({ runner, sessionPath, poolDir });
    latest = parseSessionUsageStdout(stdout);
    if (usageExtractedOk(latest)) {
      return { usage: latest, stdout };
    }
    sleepMs(1_000);
  }
  return { usage: latest ?? parseSessionUsageStdout(stdout), stdout };
}
