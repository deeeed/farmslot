'use strict';

// Shared by debug-chrome and its resource stop hook. Only the launcher's
// per-port home profiles are disposable; custom/personal profiles stay intact.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { withProbeLock } = require('../../../packages/adapter-web/src/browser-resolver.cjs');
const { cdpListenerPids } = require('../../../packages/adapter-web/src/browser-cdp.cjs');
const {
  profileProcessPids,
} = require('../../../packages/adapter-web/src/validation-process-ownership.cjs');

const cacheDir = (home) => path.join(home, '.cache', 'farmslot');

function profileLock(profile, fn, { home = os.homedir(), waitMs = 30000 } = {}) {
  const dir = cacheDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withProbeLock(
    path.join(dir, 'chrome-profile'),
    createHash('sha256').update(path.resolve(profile)).digest('hex'),
    fn,
    // Deleting a large cache can take longer than a browser probe. A live
    // cleanup holder must never be displaced by another launch.
    { waitMs, keepLiveOwner: true },
  );
}

function readFleet() {
  const cli =
    process.env.FARMSLOT_CLI || path.resolve(__dirname, '../../../packages/cli/bin/farmslot.mjs');
  return JSON.parse(
    execFileSync(cli, ['rpc', 'fleet.status', '{}'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ).fleet;
}

function slotIsInactive(fleet, port, machine, stopping) {
  if (
    !fleet ||
    fleet.stale ||
    !Array.isArray(fleet.slots) ||
    !Number.isFinite(Date.parse(fleet.checkedAt)) ||
    Date.now() - Date.parse(fleet.checkedAt) > 300000
  )
    return false;
  const local = fleet.slots.filter((slot) => slot.machine === machine);
  // Disabled pool placeholders have no resource definition and can retain a
  // historical taskId. They cannot own a port without a current run or worker.
  const configured = local.filter(
    (slot) =>
      !(
        !slot.resources &&
        slot.enabled === false &&
        slot.lifecycle === 'disabled' &&
        !slot.currentRunId &&
        slot.agent === '-'
      ),
  );
  // A missing machine or incomplete config is uncertainty, not an unbound port.
  if (
    !local.length ||
    configured.some((slot) => !slot.resources || typeof slot.resources !== 'object')
  )
    return false;
  const slots = configured.filter((slot) =>
    Object.values(slot.resources).some(
      (resource) => resource && Number(resource.cdp_port) === port,
    ),
  );
  return slots.every(
    (slot) =>
      (stopping && slot.lifecycle === 'busy' && slot.phase === 'releasing') ||
      (['ready', 'disabled'].includes(slot.lifecycle) &&
        !slot.currentRunId &&
        !slot.taskId &&
        ['idle', 'no-tmux', '-'].includes(slot.agent)),
  );
}

async function reapProfiles({
  home = os.homedir(),
  machine = os.hostname().replace(/\.local$/, ''),
  excludeProfile,
  onlyProfile,
  getFleet = readFleet,
  profilePids = profileProcessPids,
  listenerPids = cdpListenerPids,
} = {}) {
  const result = { removed: [], kept: [], skipped: null, errors: [] };
  if (
    onlyProfile &&
    (path.dirname(onlyProfile) !== home ||
      !/^\.chrome-farmslot-[1-9]\d*$/.test(path.basename(onlyProfile)))
  ) {
    result.kept.push(onlyProfile);
    return result;
  }
  let fleet;
  try {
    fleet = getFleet();
  } catch {
    // Offline/unavailable gateway: preserve every profile. Launching Chrome
    // itself must still work when the control plane is unavailable.
    result.skipped = 'gateway slot ownership unavailable';
    return result;
  }
  for (const name of fs.readdirSync(home)) {
    const match = /^\.chrome-farmslot-([1-9]\d*)$/.exec(name);
    if (!match) continue;
    const profile = path.join(home, name);
    const port = Number(match[1]);
    if (port > 65535 || profile === excludeProfile || (onlyProfile && profile !== onlyProfile))
      continue;
    let info;
    try {
      info = fs.lstatSync(profile);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    await profileLock(
      profile,
      async () => {
        let inactive;
        try {
          // Read owner state inside the same lock taken before a new browser is
          // spawned. A stale fleet or failed process/socket probe preserves data.
          fleet = getFleet();
          inactive =
            slotIsInactive(fleet, port, machine, Boolean(onlyProfile)) &&
            profilePids(profile).length === 0 &&
            listenerPids(port).length === 0;
        } catch (error) {
          result.kept.push(profile);
          result.errors.push({ profile, code: error.code || error.name });
          return;
        }
        if (!inactive) {
          result.kept.push(profile);
          return;
        }
        await fs.promises.rm(profile, { recursive: true, force: true });
        result.removed.push(profile);
      },
      { home },
    );
  }
  return result;
}

async function main([action, profile, chrome, ...args]) {
  if (action === 'launch') {
    await profileLock(profile, async () => {
      fs.mkdirSync(profile, { recursive: true });
      const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
      await once(child, 'spawn');
      child.unref();
    });
    return;
  }
  if (action === 'schedule') {
    const dir = cacheDir(os.homedir());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(dir, 'chrome-profile-cleanup.log'), 'w', 0o600);
    try {
      const child = spawn(process.execPath, [__filename, 'reap', profile], {
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      await once(child, 'spawn');
      child.unref();
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  if (action !== 'reap' && action !== 'reap-one') throw new Error('Unknown Chrome cleanup action');
  console.log(
    JSON.stringify(
      await reapProfiles(
        action === 'reap-one' ? { onlyProfile: profile } : { excludeProfile: profile },
      ),
    ),
  );
}

module.exports = { profileLock, reapProfiles, slotIsInactive };
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
