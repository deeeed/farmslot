'use strict';

const { execFileSync, spawnSync } = require('node:child_process');

function commandHasExactProfile(command, profile) {
  const expected = `--user-data-dir=${profile}`;
  let offset = command.indexOf(expected);
  while (offset !== -1) {
    const before = offset === 0 ? '' : command[offset - 1];
    const after = command[offset + expected.length] || '';
    if ((!before || /\s/u.test(before)) && (!after || /\s/u.test(after))) return true;
    offset = command.indexOf(expected, offset + 1);
  }
  return false;
}

function profileProcessPids(profile) {
  const output = execFileSync('ps', ['-ww', '-axo', 'pid=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pids = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/u);
    if (!match || !commandHasExactProfile(match[2], profile)) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid && pid !== process.ppid) pids.push(pid);
  }
  return [...new Set(pids)];
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// A process that already exited but has not been reaped yet (zombie) still
// answers `kill(pid, 0)`. The synchronous stop loop below never yields to the
// event loop, so a spawned child that dies immediately stays a zombie until the
// launcher returns; it must not count as a surviving browser.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  // Requires macOS or procps ps; a ps that rejects these flags prints nothing, which is treated as dead.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

function uniquePids(pids) {
  return [...new Set(pids)].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
  );
}

// Reap every live process that still owns this profile, then refuse to continue
// if any survive. `open -n` otherwise starts a second headed Chrome on the same
// user-data-dir while the previous instance is still dying.
/**
 * @param {string} profile
 * @param {{ extraPids?: number[], timeoutMs?: number, waitForAppearanceMs?: number }} [options]
 */
function stopProfileProcessesSync(
  profile,
  { extraPids = [], timeoutMs = 5_000, waitForAppearanceMs = 0 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const appearUntil = Date.now() + Math.max(0, waitForAppearanceMs);
  let ownersSince = 0;
  while (Date.now() < deadline) {
    const pids = uniquePids([...profileProcessPids(profile), ...extraPids.filter(pidAlive)]);
    if (pids.length === 0) {
      if (Date.now() >= appearUntil) return;
    } else {
      if (ownersSince === 0) ownersSince = Date.now();
      signalPids(pids, Date.now() - ownersSince >= 500 ? 'SIGKILL' : 'SIGTERM');
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  const remaining = uniquePids([...profileProcessPids(profile), ...extraPids.filter(pidAlive)]);
  if (remaining.length > 0) {
    throw new Error(
      `Owned Chrome processes survived stop (pid ${remaining.join(', ')}). ` +
        'Next: stop the runtime that owns this profile, then rerun.',
    );
  }
}

async function stopProfileProcesses(profile, { quietMs = 0, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = Date.now();
  let ownersSince = 0;
  while (Date.now() < deadline) {
    const pids = profileProcessPids(profile);
    if (pids.length === 0) {
      ownersSince = 0;
      if (Date.now() - quietSince >= quietMs) return;
    } else {
      if (ownersSince === 0) ownersSince = Date.now();
      quietSince = Date.now();
      signalPids(pids, Date.now() - ownersSince >= 500 ? 'SIGKILL' : 'SIGTERM');
    }
    await delay(50);
  }
  const remaining = profileProcessPids(profile);
  if (remaining.length > 0) {
    throw new Error(
      `Extension validation profile processes survived cleanup: ${remaining.join(', ')}.`,
    );
  }
  throw new Error(`Extension validation profile did not remain quiescent for ${quietMs}ms.`);
}

module.exports = { profileProcessPids, stopProfileProcesses, stopProfileProcessesSync };
