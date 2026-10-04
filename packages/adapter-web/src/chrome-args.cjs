'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_IDENTITY_FILENAME = 'extension-runtime-identity.json';
const RUNTIME_NONCE_PREFIX = '--mm-harness-runtime-nonce=';
const DETACHED_LAUNCH_UNPROVEN_FILENAME = '.mm-harness-detached-launch-unproven';
// chrome-args.cjs — single source of truth for the remote-debugging launch flags
// shared by BOTH extension launchers: the fresh spawn (launch-browser.cjs) and the
// reopen path (ensure-browser.sh → reopen-browser.sh). Keeping the debug-port trio
// here means `--remote-allow-origins` can never drift away from the port it scopes:
// the two are declared once and always travel together. Without the allow-origins
// entry Chrome 403s every browser DevTools WebSocket on the debug port and
// `mm-harness debug` cannot attach a visible console.

// The exact origin allowed is the locally-served bundled DevTools frontend, which
// Chrome serves at http://127.0.0.1:<cdpPort>. Scoped to that origin — never `*`.
function remoteDebuggingArgs(cdpPort) {
  const port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`remoteDebuggingArgs: invalid cdp port: ${cdpPort}`);
  }
  return [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ];
}

// An isolated automation profile must never ask for or write credentials in the
// operator's macOS login keychain. Chromium's mock keychain keeps profile-local
// encryption deterministic and prevents modal prompts from blocking startup.
function isolatedProfileArgs(platform = process.platform) {
  return platform === 'darwin' ? ['--use-mock-keychain'] : [];
}

// Keep requestAnimationFrame, transitions, and input hit testing alive when the
// slot-owned browser is occluded by the operator's other windows.
function automationRuntimeArgs() {
  return [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
}

function createRuntimeIdentityNonce() {
  return crypto.randomBytes(32).toString('hex');
}

function runtimeIdentityArgs(nonce) {
  if (!/^[a-f0-9]{64}$/u.test(nonce)) {
    throw new Error('runtimeIdentityArgs: nonce must be 32 bytes encoded as lowercase hex');
  }
  return ['--enable-automation', `${RUNTIME_NONCE_PREFIX}${nonce}`];
}

function runtimeIdentityPath(runtimeDir) {
  return path.join(path.resolve(runtimeDir), RUNTIME_IDENTITY_FILENAME);
}

function detachedLaunchUnprovenPath(profile) {
  return path.join(path.resolve(profile), DETACHED_LAUNCH_UNPROVEN_FILENAME);
}

function validationPortQuarantineRoot() {
  if (typeof process.getuid !== 'function') {
    throw new Error('Extension validation port quarantine requires a POSIX user identity.');
  }
  const uid = process.getuid();
  const root = path.join(fs.realpathSync('/tmp'), `mm-harness-extension-validation-${uid}`);
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(root);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(`Extension validation quarantine root is not an owner-only directory: ${root}`);
  }
  return root;
}

function validationPortQuarantinePath(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`validationPortQuarantinePath: invalid cdp port: ${port}`);
  }
  return path.join(validationPortQuarantineRoot(), `port-${numericPort}.json`);
}

function readValidationPortQuarantine(port) {
  const destination = validationPortQuarantinePath(port);
  let descriptor;
  try {
    descriptor = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.size <= 0 ||
      stat.size > 4_096 ||
      (stat.mode & 0o777) !== 0o600
    ) {
      return { path: destination };
    }
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (
      value.schemaVersion !== 1 ||
      value.port !== Number(port) ||
      typeof value.profile !== 'string' ||
      (value.lease !== undefined && !/^[a-f0-9]{64}$/u.test(value.lease))
    ) {
      return { path: destination };
    }
    return {
      path: destination,
      profile: value.profile,
      ...(value.lease === undefined ? {} : { lease: value.lease }),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { path: destination };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeValidationPortQuarantine(port, profile, reason, allowExisting, lease) {
  const destination = validationPortQuarantinePath(port);
  const pending = path.join(
    path.dirname(destination),
    `.port-${Number(port)}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.pending`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      pending,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        port: Number(port),
        profile: path.resolve(profile),
        reason: String(reason).slice(0, 1_024),
        ...(lease === undefined ? {} : { lease }),
      })}\n`,
      'utf8',
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(pending, destination);
    return destination;
  } catch (error) {
    if (allowExisting && error.code === 'EEXIST') return destination;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor is already gone; the outcome is decided elsewhere.
      }
    }
    try {
      fs.unlinkSync(pending);
    } catch (error) {
      // A leftover pending file is a real failure, even after the link succeeded.
      // eslint-disable-next-line no-unsafe-finally
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function markValidationPortLaunchUnproven(port, profile, lease) {
  if (lease !== undefined && !/^[a-f0-9]{64}$/u.test(lease)) {
    throw new Error('markValidationPortLaunchUnproven: invalid lease');
  }
  return writeValidationPortQuarantine(
    port,
    profile,
    'A detached browser launch was submitted but ownership was not proven.',
    false,
    lease,
  );
}

function quarantineValidationPort(port, profile, reason) {
  return writeValidationPortQuarantine(port, profile, reason, true, undefined);
}

function clearValidationPortQuarantine(port, profile, lease) {
  const quarantine = readValidationPortQuarantine(port);
  if (!quarantine) return;
  if (
    quarantine.profile !== path.resolve(profile) ||
    (quarantine.lease !== undefined && quarantine.lease !== lease)
  ) {
    throw new Error(
      `Extension validation port ${port} is quarantined for another or invalid profile.`,
    );
  }
  fs.unlinkSync(quarantine.path);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function validationLaunchQuarantineError(port, ownerProfile, requestedProfile) {
  const portMarker = validationPortQuarantinePath(port);
  const profiles = [
    ...new Set(
      [ownerProfile, requestedProfile]
        .filter((profile) => typeof profile === 'string')
        .map((profile) => path.resolve(profile)),
    ),
  ];
  const markers = [...profiles.map(detachedLaunchUnprovenPath), portMarker];
  const profileText = profiles.length > 0 ? ` or profile ${profiles.join(' or ')}` : '';
  return new Error(
    `Refusing to launch on CDP port ${port} because its detached browser state is quarantined. ` +
      `Next: confirm no browser uses port ${port}${profileText}, then run: rm -- ${markers.map(shellQuote).join(' ')}`,
  );
}

function writeDetachedLaunchMarker(profile, reason, allowExisting) {
  const destination = detachedLaunchUnprovenPath(profile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${reason}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    return destination;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor is already gone; the outcome is decided elsewhere.
      }
    }
    if (allowExisting && error.code === 'EEXIST') return destination;
    throw error;
  }
}

function markDetachedLaunchUnproven(profile) {
  return writeDetachedLaunchMarker(
    profile,
    'A detached browser launch was submitted but ownership was not proven.',
    false,
  );
}

function quarantineDetachedLaunch(profile, reason) {
  return writeDetachedLaunchMarker(profile, reason, true);
}

function hasDetachedLaunchUnproven(profile) {
  return fs.lstatSync(detachedLaunchUnprovenPath(profile), { throwIfNoEntry: false }) !== undefined;
}

function clearDetachedLaunchUnproven(profile) {
  const destination = detachedLaunchUnprovenPath(profile);
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Detached launch marker is not a regular file: ${destination}`);
  }
  fs.unlinkSync(destination);
}

function removeRuntimeIdentity(runtimeDir) {
  fs.rmSync(runtimeIdentityPath(runtimeDir), { force: true });
}

function writeRuntimeIdentity(runtimeDir, identity) {
  assertRuntimeIdentity(identity);
  const destination = runtimeIdentityPath(runtimeDir);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${RUNTIME_IDENTITY_FILENAME}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(identity)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor is already gone; the outcome is decided elsewhere.
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function assertRuntimeIdentity(identity) {
  if (
    !identity ||
    !Number.isInteger(identity.port) ||
    identity.port <= 0 ||
    identity.port > 65535 ||
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isInteger(identity.startedAt) ||
    identity.startedAt <= 0 ||
    !/^[a-f0-9]{64}$/u.test(identity.nonce)
  ) {
    throw new Error('writeRuntimeIdentity: invalid runtime identity');
  }
}

module.exports = {
  DETACHED_LAUNCH_UNPROVEN_FILENAME,
  RUNTIME_IDENTITY_FILENAME,
  RUNTIME_NONCE_PREFIX,
  automationRuntimeArgs,
  clearDetachedLaunchUnproven,
  clearValidationPortQuarantine,
  createRuntimeIdentityNonce,
  detachedLaunchUnprovenPath,
  hasDetachedLaunchUnproven,
  isolatedProfileArgs,
  markDetachedLaunchUnproven,
  markValidationPortLaunchUnproven,
  quarantineDetachedLaunch,
  quarantineValidationPort,
  readValidationPortQuarantine,
  remoteDebuggingArgs,
  removeRuntimeIdentity,
  runtimeIdentityArgs,
  runtimeIdentityPath,
  shellQuote,
  validationLaunchQuarantineError,
  validationPortQuarantinePath,
  writeRuntimeIdentity,
};
