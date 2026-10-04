'use strict';

// macOS focus helpers for launchers that start a headed browser in the
// background. One owner (the launcher) and one decision: after the launch
// settles, if the frontmost process is one of OUR browser pids, give the front
// back to the app that had it, once, by pid. Anything else in front (the
// operator's own Chrome included, whatever its bundle) is left alone. A restore
// only activates an already-running app (never `open -a`, which can launch).
// FARMSLOT_FOCUS_HOLD=0 makes every function here a no-op (tests).

const { execFileSync } = require('node:child_process');

// Upper bound for one Launch Services query or activation.
const LS_TIMEOUT_MS = 2000;
// Activates a running app by pid; prints "missing" for a pid with no app.
const ACTIVATE_BY_PID = [
  'function run(argv) {',
  "  ObjC.import('AppKit');",
  '  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));',
  "  if (!app || app.isNil()) return 'missing';",
  "  return app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps) ? 'ok' : 'failed';",
  '}',
].join('\n');

function macFocusDisabled() {
  return (
    process.platform !== 'darwin' ||
    process.env.FARMSLOT_FOCUS_HOLD === '0' ||
    process.env.FARMSLOT_FOCUS_BROWSER === '1'
  );
}

// At most one restore per launcher process.
let restored = false;

function lsappinfo(args) {
  return execFileSync('lsappinfo', args, {
    encoding: 'utf8',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: LS_TIMEOUT_MS,
  });
}

function parseLsappinfo(info) {
  const pid = Number.parseInt(
    (info.match(/\bpid\s*=\s*(\d+)/u) || info.match(/"pid"=(\d+)/u) || [])[1],
    10,
  );
  const bundlePath = (info.match(/bundle path="([^"]+)"/u) ||
    info.match(/"LSBundlePath"="([^"]+)"/u) ||
    [])[1];
  const name = (info.match(/^"([^"]+)"/mu) || info.match(/"LSDisplayName"="([^"]+)"/u) || [])[1];
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, bundlePath: bundlePath || null, name: name || bundlePath || `pid ${pid}` };
}

// The frontmost app as { pid, bundlePath, name }, or null when unknown.
function captureMacFrontmost() {
  if (macFocusDisabled()) return null;
  try {
    const asn = lsappinfo(['front']).trim();
    return asn ? parseLsappinfo(lsappinfo(['info', asn])) : null;
  } catch {
    // Best effort: lsappinfo missing, timed out, or the app exited.
    return null;
  }
}

function macFrontmostPid() {
  return captureMacFrontmost()?.pid ?? null;
}

// Bring an already-running app to the front by pid. Never launches anything.
function activateMacAppByPid(pid) {
  if (macFocusDisabled() || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    return (
      execFileSync('osascript', ['-l', 'JavaScript', '-e', ACTIVATE_BY_PID, String(pid)], {
        encoding: 'utf8',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: LS_TIMEOUT_MS,
      }).trim() === 'ok'
    );
  } catch {
    // Best effort: osascript failed or timed out; the operator keeps whatever is in front.
    return false;
  }
}

// One check, at most one restore: 'restored' when our browser had the front
// and `previous` got it back, 'kept' when anything else is in front (left as
// is), 'off' when focus handling is disabled or there is nothing to restore.
// A click on the slot window right after launch can therefore be undone once.
function restoreFrontmostIfOurs(previous, ourPids) {
  if (macFocusDisabled() || restored || !Number.isInteger(previous?.pid) || previous.pid <= 0)
    return 'off';
  const ours = new Set((ourPids || []).filter((pid) => Number.isInteger(pid) && pid > 0));
  if (ours.size === 0 || ours.has(previous.pid)) return 'off';
  const front = macFrontmostPid();
  if (front === null || !ours.has(front)) return 'kept';
  restored = true;
  return activateMacAppByPid(previous.pid) ? 'restored' : 'kept';
}

function macBackgroundOpenArgs(application, chromeArgs) {
  return ['-g', '-n', '-a', application, '--args', ...chromeArgs];
}

module.exports = {
  activateMacAppByPid,
  captureMacFrontmost,
  macBackgroundOpenArgs,
  macFocusDisabled,
  macFrontmostPid,
  restoreFrontmostIfOurs,
};
