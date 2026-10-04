#!/usr/bin/env node
'use strict';

const dgram = require('node:dgram');
const { execFileSync, spawn } = require('node:child_process');
const {
  clearValidationPortQuarantine,
  createRuntimeIdentityNonce,
  hasDetachedLaunchUnproven,
  markValidationPortLaunchUnproven,
  quarantineDetachedLaunch,
  quarantineValidationPort,
  readValidationPortQuarantine,
  validationLaunchQuarantineError,
} = require('./chrome-args.cjs');
const { stopProfileProcesses } = require('./validation-process-ownership.cjs');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof process.send !== 'function') {
  process.exit(2);
}

const socket = dgram.createSocket('udp4');
let launchChild;
let launchLease;
let ownsPortLease = false;
let launchRequest;
let launchFinished = false;
let finishStarted = false;
let finalizing = false;
let releaseRequest;
let profileCleaned = false;

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

function send(message, callback = () => {}) {
  if (!process.connected) {
    callback();
    return;
  }
  process.send(message, callback);
}

function signalLaunchTree(signal) {
  if (!launchChild?.pid) return;
  if (process.platform === 'win32') launchChild.kill(signal);
  else signalPids(launchTreePids(), signal);
}

function launchTreeExists() {
  if (!launchChild?.pid) return false;
  if (process.platform !== 'win32') return launchTreePids().length > 0;
  try {
    process.kill(launchChild.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function launchTreePids() {
  const output = execFileSync('ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pids = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/u);
    if (match && Number(match[2]) === launchChild.pid) pids.push(Number(match[1]));
  }
  return pids.filter((pid) => pid !== process.pid);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopRemainingLaunchTree() {
  if (!launchTreeExists()) return;
  signalLaunchTree('SIGTERM');
  const termDeadline = Date.now() + 1_000;
  while (launchTreeExists() && Date.now() < termDeadline) await delay(50);
  if (!launchTreeExists()) return;
  signalLaunchTree('SIGKILL');
  const killDeadline = Date.now() + 1_000;
  while (launchTreeExists() && Date.now() < killDeadline) await delay(50);
  if (launchTreeExists())
    throw new Error(
      `Extension validation launcher process group ${launchChild.pid} survived SIGKILL.`,
    );
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

function closeSocket() {
  return new Promise((resolve) => socket.close(resolve));
}

async function cleanProfile(quietMs) {
  await stopProfileProcesses(launchRequest.profile, { quietMs });
  profileCleaned = true;
}

function quarantineProfile(error) {
  let quarantineError;
  try {
    quarantineDetachedLaunch(launchRequest.profile, error.message);
  } catch (markerError) {
    quarantineError = markerError;
  }
  try {
    quarantineValidationPort(port, launchRequest.profile, error.message);
  } catch (markerError) {
    quarantineError ||= markerError;
  }
  return quarantineError
    ? new Error(
        `${error.message} Extension validation could not persist quarantine: ${quarantineError.message}`,
      )
    : error;
}

async function finalize(preserveProfileOwner) {
  if (finalizing) return;
  finalizing = true;
  let finalError;
  if (launchRequest && !preserveProfileOwner && !profileCleaned) {
    try {
      await cleanProfile(2_000);
    } catch (error) {
      finalError = quarantineProfile(error);
    }
  }
  if (launchRequest && ownsPortLease && !finalError) {
    try {
      const detachedLaunchUnproven = hasDetachedLaunchUnproven(launchRequest.profile);
      if (preserveProfileOwner && detachedLaunchUnproven) {
        throw new Error('Extension validation cannot release an unproven detached browser launch.');
      }
      if (!detachedLaunchUnproven) {
        clearValidationPortQuarantine(port, launchRequest.profile, launchLease);
        ownsPortLease = false;
      }
    } catch (error) {
      finalError = quarantineProfile(error);
    }
  }
  await closeSocket();
  if (finalError)
    send({ type: 'release-error', message: finalError.message }, () => process.exit(1));
  else process.exit(0);
}

async function finish(result) {
  if (finishStarted) return;
  finishStarted = true;
  let finalResult = result;
  let launchTreeError;
  try {
    await stopRemainingLaunchTree();
  } catch (error) {
    launchTreeError = quarantineProfile(error);
  }
  if (
    launchRequest &&
    (launchTreeError || result.exitCode !== 0 || result.timedOut || result.error)
  ) {
    let detachedLaunchUnproven = false;
    try {
      detachedLaunchUnproven = hasDetachedLaunchUnproven(launchRequest.profile);
    } catch (error) {
      launchTreeError ||= quarantineProfile(error);
    }
    try {
      await cleanProfile(
        detachedLaunchUnproven || result.timedOut || result.error || launchTreeError ? 2_000 : 0,
      );
    } catch (error) {
      launchTreeError ||= quarantineProfile(error);
    }
  }
  if (launchTreeError) {
    finalResult = {
      type: 'result',
      exitCode: null,
      timedOut: result.timedOut,
      error: launchTreeError.message,
    };
  }
  launchFinished = true;
  send(finalResult);
  if (releaseRequest !== undefined || !process.connected) void finalize(releaseRequest === true);
}

function startLaunch(message) {
  if (
    launchChild ||
    !message ||
    typeof message.command !== 'string' ||
    !Array.isArray(message.args) ||
    typeof message.profile !== 'string'
  ) {
    send(
      { type: 'error', message: 'Invalid extension validation supervisor launch request.' },
      () => process.exit(2),
    );
    return;
  }
  const timeoutMs = Number(message.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    send({ type: 'error', message: 'Invalid extension validation supervisor timeout.' }, () =>
      process.exit(2),
    );
    return;
  }
  launchRequest = message;
  const lease = createRuntimeIdentityNonce();
  launchLease = lease;
  try {
    markValidationPortLaunchUnproven(port, message.profile, lease);
    ownsPortLease = true;
  } catch (error) {
    void finish({ type: 'result', exitCode: null, timedOut: false, error: error.message });
    return;
  }
  launchChild = spawn(message.command, message.args, {
    cwd: message.cwd,
    env: {
      ...message.env,
      FARMSLOT_VALIDATION_PORT_LEASE: lease,
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launchChild.stdout.pipe(process.stdout);
  launchChild.stderr.pipe(process.stderr);
  let timedOut = false;
  let killTimer;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      signalLaunchTree('SIGTERM');
    } catch (error) {
      void finish({ type: 'result', exitCode: null, timedOut, error: error.message });
      return;
    }
    killTimer = setTimeout(() => {
      try {
        signalLaunchTree('SIGKILL');
      } catch (error) {
        void finish({ type: 'result', exitCode: null, timedOut, error: error.message });
      }
    }, 1_000);
    killTimer.unref();
  }, timeoutMs);
  launchChild.once('error', (error) => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    void finish({ type: 'result', exitCode: null, timedOut, error: error.message });
  });
  launchChild.once('close', (exitCode) => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    void finish({ type: 'result', exitCode, timedOut });
  });
}

process.on('message', (message) => {
  if (message?.type === 'run') startLaunch(message);
  if (message?.type === 'release') {
    releaseRequest = message.preserveProfileOwner === true;
    if (launchFinished) void finalize(releaseRequest);
  }
  if (message?.type === 'cancel' && !launchChild) {
    releaseRequest = false;
    void finish({ type: 'cancelled', timedOut: false });
  }
});

process.on('disconnect', () => {
  releaseRequest = false;
  if (!launchChild) {
    void finish({ type: 'cancelled', timedOut: false });
    return;
  }
  launchChild.stdout.unpipe(process.stdout);
  launchChild.stderr.unpipe(process.stderr);
  launchChild.stdout.resume();
  launchChild.stderr.resume();
  if (launchFinished) void finalize(false);
});

socket.once('error', (error) => {
  const message =
    error.code === 'EADDRINUSE'
      ? `Extension validation runtime is already preparing on port ${port}.`
      : error.message;
  send({ type: 'error', message }, () => process.exit(1));
});
const existingQuarantine = readValidationPortQuarantine(port);
if (existingQuarantine) {
  send(
    {
      type: 'error',
      message: validationLaunchQuarantineError(port, existingQuarantine.profile).message,
    },
    () => process.exit(1),
  );
} else {
  socket.bind({ address: '127.0.0.1', port, exclusive: true }, () => send({ type: 'ready' }));
}
