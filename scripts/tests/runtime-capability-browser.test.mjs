import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(
  repoRoot,
  'projects/farmslot-farm/setup/runtime-capability-browser.sh',
);

async function fixture(t, listenerPid = '') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-capability-browser-'));
  const bin = path.join(directory, 'bin');
  const profile = path.join(directory, 'profile');
  await mkdir(bin);
  await mkdir(profile);
  await writeFile(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 1\n');
  await writeFile(
    path.join(bin, 'lsof'),
    `#!/usr/bin/env bash\n[ -n "${listenerPid}" ] && printf '%s\\n' "${listenerPid}"\n`,
  );
  await chmod(path.join(bin, 'curl'), 0o755);
  await chmod(path.join(bin, 'lsof'), 0o755);

  const port = String(49_000 + Math.floor(Math.random() * 1_000));
  const owner = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => undefined, 1000)',
      '--',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
    ],
    { stdio: 'ignore' },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  await symlink(`${os.hostname()}-${owner.pid}`, path.join(profile, 'SingletonLock'));
  t.after(async () => {
    if (owner.exitCode === null) owner.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });
  return {
    owner,
    port,
    profile,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FARMSLOT_CDP_PROFILE: profile },
  };
}

test('browser stop terminates its matching profile owner when CDP is unhealthy', async (t) => {
  const value = await fixture(t);
  const ownerExit = new Promise((resolve) => value.owner.once('exit', resolve));
  await execFileAsync('bash', [scriptPath, 'stop', '--cdp-port', value.port], {
    cwd: repoRoot,
    env: value.env,
  });
  await ownerExit;
  assert.equal(value.owner.signalCode, 'SIGTERM');
});

test('browser stop refuses a listener that is not the matching profile owner', async (t) => {
  const value = await fixture(t, String(process.pid));
  await assert.rejects(
    execFileAsync('bash', [scriptPath, 'stop', '--cdp-port', value.port], {
      cwd: repoRoot,
      env: value.env,
    }),
    /does not own CDP endpoint/,
  );
  assert.equal(value.owner.exitCode, null);
});
