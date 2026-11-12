import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeVars } from '../runners/test-fixtures.js';

import { execArgvOnSlot, execLocal, execOnSlot } from './exec.js';
import { withFarmGitArgv, withFarmGitConfig } from './farm-git.js';

test('only explicit farm Git payloads override maintenance config', async (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'slot-git-maintenance-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env });
  git('init', '-q');
  git('config', 'gc.auto', '1');
  git('config', 'maintenance.auto', 'true');
  const config = readFileSync(path.join(repo, '.git/config'), 'utf8');
  const vars = makeVars({ host: 'localhost', machine: 'fixture', remoteRepo: repo });
  const command = 'git config --get gc.auto && git config --get maintenance.auto';
  assert.equal((await execOnSlot(vars, command)).stdout, '1\ntrue\n');
  assert.equal((await execOnSlot(vars, withFarmGitConfig(command))).stdout, '0\nfalse\n');
  assert.equal((await execArgvOnSlot(vars, ['git', 'config', '--get', 'gc.auto'])).stdout, '1\n');
  const python =
    "import subprocess; subprocess.run(['git', 'config', '--get', 'maintenance.auto'], check=True)";
  assert.equal((await execArgvOnSlot(vars, ['python3', '-c', python])).stdout, 'true\n');
  assert.equal(
    (await execArgvOnSlot(vars, withFarmGitArgv(['python3', '-c', python]))).stdout,
    'false\n',
  );
  const payload = 'literal ; `exit 3` $(exit 4) "quotes"\nnewline';
  assert.equal((await execArgvOnSlot(vars, ['printf', '%s', payload])).stdout, payload);
  assert.equal(
    (await execArgvOnSlot(vars, withFarmGitArgv(['printf', '%s', payload]))).stdout,
    payload,
  );
  assert.equal((await execOnSlot(vars, 'exit 17')).exitCode, 17);
  assert.equal((await execLocal(command, { cwd: repo })).stdout, '1\ntrue\n');
  assert.equal(readFileSync(path.join(repo, '.git/config'), 'utf8'), config);
});

test('farm config preserves inherited parameters and overrides inherited maintenance settings', () => {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_PARAMETERS: "'fixture.setting=spaces and '\\''quotes'\\''' 'gc.auto=1'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'true',
  };
  const result = execFileSync(
    'bash',
    [
      '-c',
      withFarmGitConfig(
        [
          'git config --get fixture.setting',
          'git config --get gc.auto',
          'git config --get maintenance.auto',
        ].join(' && '),
      ),
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(result, "spaces and 'quotes'\n0\nfalse\n");
});
