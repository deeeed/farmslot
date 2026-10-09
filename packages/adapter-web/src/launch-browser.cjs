'use strict';
// launch-browser.cjs — per-instance isolated detached Chrome launch
//
// Starts a detached Chrome bound to 127.0.0.1:<cdpPort> with its own profile and
// an unpacked extension loaded: by --load-extension, or over CDP
// (Extensions.loadUnpacked) for branded Chrome, which ignores that flag. The
// browser choice comes from the resolver record (`browserResolution`) when it
// names `chromeBin`.
//
// Writes: the pid file, an append-only Chrome log, and under `runtimeDir` the
// resolution record (browser-resolution.json) and the runtime identity. Never
// touches the extension dir (read-only) or anything outside the paths it is given.
//
// Product knowledge comes from the caller: the extension page to open
// (`homePage`), that page's own title (`defaultTitle`), how to recognise an
// owned browser by its extension path (`extensionOwnerRoot`), a lock held for
// the whole launch (`acquireRuntimeLock`), and the rerun command for hints.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { cdpListenerPids } = require('./browser-cdp.cjs');
const {
  CDP_LOAD_UNPACKED,
  describeBrowser,
  extensionLaunchArgs,
  waitForCdpOwner,
} = require('./browser-resolver.cjs');
const {
  automationRuntimeArgs,
  clearDetachedLaunchUnproven,
  clearValidationPortQuarantine,
  createRuntimeIdentityNonce,
  detachedLaunchUnprovenPath,
  hasDetachedLaunchUnproven,
  isolatedProfileArgs,
  markDetachedLaunchUnproven,
  markValidationPortLaunchUnproven,
  readValidationPortQuarantine,
  remoteDebuggingArgs,
  removeRuntimeIdentity,
  runtimeIdentityArgs,
  shellQuote,
  validationLaunchQuarantineError,
  validationPortQuarantinePath,
  writeRuntimeIdentity,
} = require('./chrome-args.cjs');
const { extensionIdFromExtensionDir } = require('./extension-id.cjs');
const {
  captureMacFrontmost,
  macBackgroundOpenArgs,
  restoreFrontmostIfOurs,
} = require('./macos-focus.cjs');
const {
  profileProcessPids,
  stopProfileProcessesSync,
} = require('./validation-process-ownership.cjs');

// The resolver CLI runs as a bounded child for CDP calls the launch must not hang on.
const BROWSER_RESOLVER_CLI = require.resolve('./browser-resolver.cjs');

/**
 * @typedef {object} LaunchBrowserOptions
 * @property {number} cdpPort
 * @property {string} chromeBin
 * @property {string} profile
 * @property {string} extensionDir Unpacked extension to load.
 * @property {string} runtimeDir Holds browser-resolution.json and the runtime identity.
 * @property {string} chromeLog
 * @property {string} chromePid
 * @property {string} [browserResolution] Resolver record for this launch; reused when it names `chromeBin`.
 * @property {string} [startUrl] First tab; defaults to the extension's `homePage`, else chrome://extensions/.
 * @property {boolean} [stopOnly] Release the profile (owned browser stopped, singleton locks cleared) without launching.
 * @property {boolean} [resetProfile] Recreate the profile; it must be a dedicated child of `runtimeDir`.
 * @property {string} [homePage] Extension page (e.g. `home.html`) opened at start and kept to one tab.
 * @property {string} [defaultTitle] That page's own title: a home tab with any other title (a slot-stamped one) is the one kept.
 * @property {(extensionDir: string) => string | null} [extensionOwnerRoot] Path prefix whose `--load-extension=` also proves a browser is ours.
 * @property {(runtimeDir: string) => () => void} [acquireRuntimeLock] Taken once the profile, log and pid directories exist, before any browser is stopped or started; the returned release runs when the launch returns or throws.
 * @property {string} [rerunCommand] Command named in "Next:" hints.
 * @property {number} [focusSettleMs] macOS: wait before the one focus check (default 1000).
 * @property {(line: string) => void} [log] Progress lines (default stderr).
 * @property {(progress: { message?: string, waitingFor?: string, current?: number, total?: number, unit?: string }) => void} [progress]
 *   What the launch is waiting for, for a caller's stage handle (`stage.progress`).
 */

/**
 * @param {LaunchBrowserOptions} options
 * @returns {{ stopped: true } | { stopped: false, pid: number }}
 */
function launchBrowser(options) {
  const opts = normalizeOptions(options);
  let release = null;
  try {
    return runLaunch(opts, () => {
      if (opts.acquireRuntimeLock) release = opts.acquireRuntimeLock(opts.runtimeDir);
    });
  } finally {
    if (typeof release === 'function') release();
  }
}

// The rerun step named in "Next:" hints.
function rerunHint({ rerunCommand }) {
  return rerunCommand ? `rerun: ${rerunCommand}` : 'rerun the launch';
}

function normalizeOptions(options) {
  const opts = { ...options };
  if (!Number.isInteger(opts.cdpPort) || opts.cdpPort <= 0)
    throw new Error(`Invalid --cdp-port: ${opts.cdpPort ?? ''}`);
  const flags = {
    chromeBin: 'chrome-bin',
    profile: 'profile',
    extensionDir: 'extension-dir',
    runtimeDir: 'runtime-dir',
    chromeLog: 'chrome-log',
    chromePid: 'chrome-pid',
  };
  for (const [key, flag] of Object.entries(flags)) {
    if (!opts[key]) throw new Error(`Missing --${flag}`);
  }
  opts.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  opts.progress = opts.progress ?? (() => {});
  return opts;
}

function runLaunch(opts, acquireLock) {
  const { cdpPort, profile, extensionDir, runtimeDir, log } = opts;
  const rerun = rerunHint(opts);
  // stopOnly releases the profile before the extension snapshot exists on a first
  // run, so launch-input validation applies only to a real launch.
  if (!opts.stopOnly) {
    if (!fs.existsSync(opts.chromeBin))
      throw new Error(`Chrome binary not found: ${opts.chromeBin}`);
    if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
      throw new Error(
        `Extension dist manifest not found: ${path.join(extensionDir, 'manifest.json')}`,
      );
    }
  }

  // Isolation guard: a standalone launch must use a per-checkout profile, never a
  // shared (e.g. ~/.chrome-farmslot) or the OS-default browser profile. Farm dispatch
  // injects its own already-isolated profile, so this only trips on a genuinely
  // personal/shared path — protecting the user's browser data.
  assertIsolatedProfile(profile);
  if (opts.resetProfile) assertResettableProfile(profile, runtimeDir);

  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.dirname(opts.chromeLog), { recursive: true });
  fs.mkdirSync(path.dirname(opts.chromePid), { recursive: true });
  acquireLock();

  const ownedBrowser = (pid) =>
    processIsOwnedBrowser(pid, profile, extensionDir, opts.extensionOwnerRoot);

  // Ownership guard: only ever take over a CDP endpoint we provably launched. A pid
  // on this port is ours iff its command line loads our --user-data-dir; anything
  // else is a browser this harness did not launch (possibly the user's personal
  // Chrome), so we refuse rather than kill it or attach to it.
  const listenerPids = cdpListenerPids(cdpPort);
  const foreignPids = listenerPids.filter((pid) => !ownedBrowser(pid));
  if (foreignPids.length > 0) throw foreignPortError(cdpPort, foreignPids);
  const ownedPids = new Set(listenerPids);
  for (const pid of profileProcessPids(profile)) ownedPids.add(pid);
  const previousPid = readPidFile(opts.chromePid);
  if (previousPid !== null && ownedBrowser(previousPid)) ownedPids.add(previousPid);
  try {
    removeRuntimeIdentity(runtimeDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to invalidate Extension runtime identity under ${runtimeDir}: ${detail}. ` +
        `Next: remove the invalid runtime identity and fix owner permissions, then ${rerun}`,
    );
  }
  stopProfileProcessesSync(profile, { extraPids: [...ownedPids] });
  if (opts.resetProfile) {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(profile, { recursive: true });
  }
  removeProfileSingletonLocks(profile);

  // stopOnly: release the profile without launching. A caller that writes into
  // the profile (fixture prefill into LevelDB) needs it unlocked first; a prior
  // run's Chrome would hold the lock and the write fails.
  if (opts.stopOnly) return { stopped: true };
  removeExtensionWorkerRegistrations(profile);

  const requestedProfileQuarantined = hasDetachedLaunchUnproven(profile);
  const portQuarantine = readValidationPortQuarantine(cdpPort);
  const validationPortLease = process.env.FARMSLOT_VALIDATION_PORT_LEASE;
  const activeValidationLease = Boolean(
    portQuarantine?.profile === path.resolve(profile) &&
    portQuarantine.lease === validationPortLease &&
    /^[a-f0-9]{64}$/u.test(validationPortLease || ''),
  );
  if (requestedProfileQuarantined || (portQuarantine && !activeValidationLease)) {
    throw validationLaunchQuarantineError(
      cdpPort,
      portQuarantine?.profile || (requestedProfileQuarantined ? profile : undefined),
      requestedProfileQuarantined ? profile : undefined,
    );
  }
  const clearLaunchMarkers = () => {
    clearDetachedLaunchUnproven(profile);
    if (!activeValidationLease) clearValidationPortQuarantine(cdpPort, profile);
  };

  const initialUrl =
    opts.startUrl || extensionPageUrl(extensionDir, opts.homePage) || 'chrome://extensions/';
  const browser = launchBrowserResolution(opts.browserResolution, opts.chromeBin);
  const loadsOverCdp = browser.extensionLoading === CDP_LOAD_UNPACKED;
  let cdpLoad = null;
  let owner = null;
  const runtimeNonce = createRuntimeIdentityNonce();
  const startedAt = Date.now();
  const chromeArgs = [
    `--user-data-dir=${profile}`,
    // Debug-port trio (address + port + scoped allow-origins) from the shared module,
    // so the DevTools origin allow-list can never drift away from the port.
    ...remoteDebuggingArgs(cdpPort),
    '--no-first-run',
    '--disable-first-run-ui',
    ...automationRuntimeArgs(),
    ...runtimeIdentityArgs(runtimeNonce),
    ...isolatedProfileArgs(),
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-extensions-file-access-check',
    '--disable-extensions-content-verification',
    '--disable-features=ExtensionContentVerification,DisableLoadExtensionCommandLineSwitch',
    ...extensionLaunchArgs(extensionDir, browser.extensionLoading),
  ];
  // Initial tab: the caller's URL when provided, else the extension home. The
  // extension home avoids leaving disposable chrome://newtab/ or extensions
  // manager tabs in the operator's slot browser. On macOS the browser starts
  // through Launch Services in the background with no startup window (Chrome
  // activates itself when it opens one), and the first window is opened over
  // CDP as a background window. A CDP-loaded extension does not exist yet at
  // startup, so its window is opened after the load.
  const application =
    process.platform === 'darwin' ? macApplicationForExecutable(opts.chromeBin) : null;
  if (application) chromeArgs.push('--no-startup-window');
  else chromeArgs.push(loadsOverCdp ? 'about:blank' : initialUrl);
  // The wait ended without an owned listener: a foreign process took the port,
  // the browser exited, or it never listened in time.
  const ownedListenerMissing = (waited) => {
    if (waited.foreignPids && waited.seen) return foreignPortError(cdpPort, waited.foreignPids);
    if (waited.foreignPids) {
      // This launch's browser was never seen, so its markers stay (see
      // awaitOwnedListener): a free port alone would be refused as quarantined.
      const markers = [detachedLaunchUnprovenPath(profile)];
      if (!activeValidationLease) markers.push(validationPortQuarantinePath(cdpPort));
      return foreignPortError(
        cdpPort,
        waited.foreignPids,
        `this launch's browser never showed up, so its launch state stays quarantined. ` +
          `Confirm no browser uses ${profile}, run: rm -- ${markers.map(shellQuote).join(' ')}, ` +
          `then pick a free --cdp-port, or stop that browser.`,
      );
    }
    const exited = waited.exited ? ': the browser exited' : '';
    return new Error(
      `Chrome launched but did not expose an owned CDP listener on 127.0.0.1:${cdpPort}${exited}. ` +
        `Next: inspect ${opts.chromeLog}, then ${rerun}`,
    );
  };
  // Any outcome but an owned listener stops what this launch started, a ps or
  // lsof failure mid-wait included. The launch markers stay until ownership is
  // proven, except when a foreign process took the port from a browser this
  // launch saw start and has now stopped: then nothing is left to quarantine,
  // and the refusal's hint (a free port) works as given.
  const awaitOwnedListener = (stopOptions, firstSightingMs) => {
    let waited;
    try {
      waited = waitForOwnedCdpPid(cdpPort, ownedBrowser, profile, opts.progress, firstSightingMs);
    } catch (error) {
      try {
        stopProfileProcessesSync(profile, stopOptions);
      } catch (stopError) {
        const pids = stopOptions.extraPids ?? [];
        const target = pids.length > 0 ? `pid ${pids.join(', ')}` : `the browser using ${profile}`;
        throw new Error(
          `Waiting for the CDP listener failed (${error.message}), and stopping the browser failed: ${stopError.message}. ` +
            `The launch markers for port ${cdpPort} and ${profile} are kept. Next: stop ${target}, then ${rerun}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (waited.pid !== undefined) return waited.pid;
    stopProfileProcessesSync(profile, stopOptions);
    if (waited.foreignPids && waited.seen) clearLaunchMarkers();
    throw ownedListenerMissing(waited);
  };
  const logFd = fs.openSync(opts.chromeLog, 'a');
  const previousFrontmost = captureMacFrontmost();
  let browserPid;
  try {
    try {
      beginDetachedLaunch(cdpPort, profile, activeValidationLease);
      opts.progress({ message: 'starting the browser' });
      if (application) {
        execFileSync('open', macBackgroundOpenArgs(application, chromeArgs), {
          env: sanitizedChildEnv(),
          stdio: ['ignore', logFd, logFd],
        });
        // `open` can return before the browser shows up in ps.
        browserPid = awaitOwnedListener({ waitForAppearanceMs: 400 }, 5000);
      } else {
        const child = spawn(opts.chromeBin, chromeArgs, {
          detached: true,
          env: sanitizedChildEnv(),
          stdio: ['ignore', logFd, logFd],
        });
        child.unref();
        // spawn returns after exec, so the browser is in ps at once.
        browserPid = awaitOwnedListener({ extraPids: child.pid ? [child.pid] : [] }, 0);
      }
      if (loadsOverCdp)
        cdpLoad = loadExtensionOverCdp(opts, browserPid, initialUrl, clearLaunchMarkers);
      else if (application) openBackgroundWindow(opts, browserPid, initialUrl, clearLaunchMarkers);
      owner = cdpLoad?.owner ?? ownerIdentity(cdpPort, profile, browserPid, log);
      for (const problem of pruneExtraHomeTabs(cdpPort, extensionDir, opts)) {
        log(`[launch] home-tab pruning: ${problem}`);
      }
    } finally {
      fs.closeSync(logFd);
    }
    fs.writeFileSync(opts.chromePid, `${browserPid}\n`);
    writeBrowserResolution(runtimeDir, {
      ...browser,
      launch: {
        pid: browserPid,
        cdpPort,
        startedAt: new Date(startedAt).toISOString(),
        ...(owner ? { profile: owner.profile, processStartedAt: owner.startedAt } : {}),
        ...(cdpLoad ? { extensionId: cdpLoad.id, otherExtensions: cdpLoad.otherExtensions } : {}),
      },
    });
    try {
      writeRuntimeIdentity(runtimeDir, {
        port: cdpPort,
        pid: browserPid,
        startedAt,
        nonce: runtimeNonce,
      });
      clearLaunchMarkers();
    } catch (error) {
      terminatePids([browserPid]);
      fs.rmSync(opts.chromePid, { force: true });
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to persist Extension runtime identity under ${runtimeDir}: ${detail}. ` +
          `Next: fix owner write permissions for the runtime directory, then ${rerun}`,
      );
    }
    if (process.platform === 'darwin') {
      const wake = spawn('caffeinate', ['-dims', '-w', String(browserPid)], {
        detached: true,
        stdio: 'ignore',
      });
      wake.unref();
      // Let the first window settle before the one focus check below.
      const settleMs =
        Number.isFinite(opts.focusSettleMs) && opts.focusSettleMs >= 0 ? opts.focusSettleMs : 1000;
      if (settleMs > 0) spawnSync('sleep', [String(settleMs / 1000)]);
    }
  } finally {
    // One check, at most one restore, and only if OUR browser (this launch's
    // CDP owner pid) holds the front; any other app in front is left alone.
    if (browserPid) {
      const outcome = restoreFrontmostIfOurs(previousFrontmost, [Number(browserPid)]);
      if (outcome === 'restored')
        log(`[launch] focus: the slot browser took the front; restored ${previousFrontmost.name}`);
    }
  }
  return { stopped: false, pid: browserPid };
}

// The first window of a browser started without one, opened in the background.
// Without it the slot has no window at all, so a failure fails the launch:
// the owned browser is stopped (its markers kept if it cannot be).
function openBackgroundWindow(opts, pid, url, clearLaunchMarkers) {
  opts.progress({ message: 'opening the start window' });
  const result = spawnSync(
    process.execPath,
    [BROWSER_RESOLVER_CLI, 'open-window', '--port', String(opts.cdpPort), '--url', url],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (result.status === 0) return;
  const openError = (result.stderr || result.error?.message || `exit ${result.status}`).trim();
  try {
    stopProfileProcessesSync(opts.profile, { extraPids: [pid] });
  } catch (stopError) {
    throw new Error(
      `Chrome started but its start window could not be opened (${openError}), and stopping it failed: ${stopError.message}. ` +
        `The launch markers for port ${opts.cdpPort} and ${opts.profile} are kept. Next: stop pid ${pid}, then ${rerunHint(opts)}`,
    );
  }
  clearLaunchMarkers();
  throw new Error(
    `Chrome started but its start window could not be opened: ${openError}. Next: inspect ${opts.chromeLog}, then ${rerunHint(opts)}`,
  );
}

// The caller passes the record its resolver just wrote; reuse it when it names
// the same binary. A direct chromeBin without it is the caller's own explicit
// choice and is recorded as such, whatever an older record of this profile says.
function launchBrowserResolution(file, chromeBin) {
  if (!file) return explicitResolution(chromeBin);
  try {
    const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (recorded && recorded.bin === chromeBin && typeof recorded.extensionLoading === 'string') {
      const { launch: _previousLaunch, ...resolution } = recorded;
      return resolution;
    }
  } catch {
    // No resolver record for this launch; fall through to a direct description.
  }
  return explicitResolution(chromeBin);
}

function explicitResolution(chromeBin) {
  return {
    schemaVersion: 2,
    ...describeBrowser(chromeBin),
    source: '--chrome-bin',
    mode: 'explicit',
    selection: 'explicit',
    resolvedAt: new Date().toISOString(),
  };
}

function writeBrowserResolution(runtime, resolution) {
  fs.writeFileSync(
    path.join(runtime, 'browser-resolution.json'),
    `${JSON.stringify(resolution, null, 2)}\n`,
  );
}

function loadExtensionOverCdp(opts, pid, initialUrl, clearLaunchMarkers) {
  opts.progress({ message: 'loading the extension over CDP' });
  const result = spawnSync(
    process.execPath,
    [
      BROWSER_RESOLVER_CLI,
      'load-unpacked',
      '--port',
      String(opts.cdpPort),
      '--path',
      opts.extensionDir,
      '--profile',
      opts.profile,
      '--open-url',
      initialUrl,
    ],
    { encoding: 'utf8', timeout: 130_000 },
  );
  if (result.status === 0) {
    const loaded = JSON.parse(result.stdout);
    opts.log(`[launch] extension ${loaded.id} loaded over CDP`);
    for (const entry of loaded.otherExtensions?.disabled ?? []) {
      opts.log(`[launch] disabled ${entry.id} (${entry.name}) in the slot profile`);
    }
    for (const entry of loaded.otherExtensions?.policyPinned ?? []) {
      opts.log(
        `[launch] WARN: enterprise policy keeps ${entry.id} (${entry.name}) enabled in the slot profile`,
      );
    }
    return loaded;
  }
  // Ownership was proven; once the browser is stopped the launch markers would
  // only quarantine a port and profile that nothing holds. If it cannot be
  // stopped, the markers stay and both failures are reported.
  const loadError = (result.stderr || result.error?.message || '').trim();
  try {
    stopProfileProcessesSync(opts.profile, { extraPids: [pid] });
  } catch (stopError) {
    throw new Error(
      `Chrome started but the extension did not load over CDP (${loadError}), and stopping it failed: ${stopError.message}. ` +
        `The launch markers for port ${opts.cdpPort} and ${opts.profile} are kept. Next: stop pid ${pid}, then ${rerunHint(opts)}`,
    );
  }
  clearLaunchMarkers();
  throw new Error(
    `Chrome started but the extension did not load over CDP: ${loadError}. ` +
      `Next: inspect ${opts.chromeLog}, or set RECIPE_HARNESS_BROWSER=cft to use Chrome for Testing, then ${rerunHint(opts)}`,
  );
}

// Identity of the browser that holds the profile (pid + start time), recorded
// so run evidence can later prove it names this exact process.
// Best effort, so a short budget: a browser that never proves ownership (a
// stub without a SingletonLock, say) costs seconds, not the full default.
function ownerIdentity(cdpPort, profile, pid, log) {
  try {
    const identity = waitForCdpOwner(cdpPort, profile, { timeoutMs: 15000 });
    return identity.pid === pid ? identity : null;
  } catch (error) {
    log(`[launch] could not record the browser identity: ${error.message}`);
    return null;
  }
}

function sanitizedChildEnv() {
  return {
    ...process.env,
    BUNDLED_DEBUGPY_PATH: undefined,
    PYTHONHOME: undefined,
    PYTHONPATH: undefined,
    DYLD_LIBRARY_PATH: undefined,
    DYLD_FALLBACK_LIBRARY_PATH: undefined,
    DYLD_INSERT_LIBRARIES: undefined,
  };
}

function beginDetachedLaunch(port, profile, activeLease) {
  try {
    if (!activeLease) markValidationPortLaunchUnproven(port, profile);
    markDetachedLaunchUnproven(profile);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const quarantine = readValidationPortQuarantine(port);
      throw validationLaunchQuarantineError(port, quarantine?.profile || profile);
    }
    throw error;
  }
}

function macApplicationForExecutable(executable) {
  let current = path.resolve(executable);
  while (current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return null;
}

function foreignPortError(port, pids, next = 'pick a free --cdp-port, or stop that browser.') {
  return new Error(
    `Refusing to launch on CDP port ${port}: it is held by a browser this harness did not launch (pid ${pids.join(', ')}). ` +
      `Next: ${next}`,
  );
}

// Polls for the launched browser's own CDP listener for up to 30 s: `{ pid }`
// once it appears, `{}` when the time is up. Stops early with `{ foreignPids }`
// once only processes it did not launch hold the port (the browser can no
// longer bind it), or with `{ exited: true }` once no process holds the
// profile. Either must hold for a second, so a brief ps/lsof gap is not taken
// for a failure. "Exited" counts only once a profile process has been seen, or
// after `firstSightingMs` with none. `seen` says whether one was.
function waitForOwnedCdpPid(port, ownedBrowser, profile, progress, firstSightingMs) {
  const budgetMs = 30_000;
  const confirmMs = 1000;
  const startedAt = Date.now();
  let seen = false;
  let exitedSince = null;
  let foreignSince = null;
  let reportedAt = startedAt;
  while (Date.now() - startedAt < budgetMs) {
    const listeners = cdpListenerPids(port);
    const pid = listeners.find(ownedBrowser);
    if (pid !== undefined) return { pid };
    const now = Date.now();
    if (profileProcessPids(profile).length > 0) {
      seen = true;
      exitedSince = null;
    } else if (seen || now - startedAt >= firstSightingMs) {
      exitedSince ??= now;
    }
    if (exitedSince !== null && now - exitedSince >= confirmMs) return { exited: true, seen };
    foreignSince = listeners.length > 0 ? (foreignSince ?? now) : null;
    if (foreignSince !== null && now - foreignSince >= confirmMs)
      return { foreignPids: listeners, seen };
    // About every 5 s: enough to show the wait is moving.
    if (now - reportedAt >= 5000) {
      reportedAt = now;
      progress({
        waitingFor: `an owned CDP listener on 127.0.0.1:${port}`,
        current: Math.round((now - startedAt) / 1000),
        total: budgetMs / 1000,
        unit: 'seconds',
      });
    }
    spawnSync('sleep', ['0.1']);
  }
  return { seen };
}

function assertIsolatedProfile(profile) {
  const resolved = path.resolve(profile);
  const home = os.homedir();
  const osDefaults = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Chromium'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/chromium'),
    path.join(home, '.config/microsoft-edge'),
  ];
  const underDefault = (dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`);
  if (
    resolved === home ||
    resolved.includes(`${path.sep}.chrome-farmslot`) ||
    osDefaults.some(underDefault)
  ) {
    throw new Error(
      `Refusing to launch: --profile ${resolved} is a shared or default browser profile; ` +
        `standalone launches must use a per-checkout profile under the harness runtime dir.`,
    );
  }
}

function assertResettableProfile(profile, expectedRuntimeDir) {
  const resolved = path.resolve(profile);
  const runtime = path.resolve(expectedRuntimeDir);
  if (!resolved.startsWith(`${runtime}${path.sep}`)) {
    throw new Error(
      `Refusing to reset --profile ${resolved}: it must be a dedicated child of ${runtime}.`,
    );
  }
  const runtimeStat = fs.lstatSync(runtime);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error(
      `Refusing to reset --profile: runtime directory is not a regular directory: ${runtime}.`,
    );
  }
  let current = runtime;
  for (const segment of path.relative(runtime, resolved).split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to reset --profile: path contains an unsafe entry: ${current}.`);
    }
  }
}

// Proof of ownership: a process is ours iff its command line loads the exact
// --user-data-dir we launch with, or an extension under the caller's owner root.
// If the process can't be inspected we treat it as NOT ours (fail safe — never
// assume ownership of an opaque process).
function processIsOwnedBrowser(pid, profile, extensionDir, extensionOwnerRoot) {
  const command = processCommand(pid);
  if (!command) return false;
  if (command.includes(`--user-data-dir=${profile}`)) return true;
  const ownerRoot = extensionOwnerRoot ? extensionOwnerRoot(path.resolve(extensionDir)) : null;
  return Boolean(ownerRoot && command.includes(`--load-extension=${ownerRoot}`));
}

function processCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readPidFile(file) {
  if (!fs.existsSync(file)) return null;
  const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function terminatePids(pids) {
  const unique = [...new Set(pids)].filter((pid) => pid !== process.pid);
  for (const pid of unique) signalPid(pid, 'SIGTERM');
  for (let i = 0; i < 10 && unique.some(processRespondsToSignal); i += 1) {
    spawnSync('sleep', ['0.2']);
  }
  for (const pid of unique) {
    if (processRespondsToSignal(pid)) signalPid(pid, 'SIGKILL');
  }
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function processRespondsToSignal(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function removeProfileSingletonLocks(profile) {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const file = path.join(profile, name);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

// Chrome keeps an unpacked extension's service worker registration, scripts
// included, across restarts and never re-registers it from --load-extension,
// even after a version bump. A preserved profile would run the background from
// whatever build first registered it, so every fresh launch drops the stored
// registrations and Chrome registers the worker from the current extension
// files. Wallet and extension storage live elsewhere and are kept.
function removeExtensionWorkerRegistrations(profile) {
  const workerDir = path.join(profile, 'Default', 'Service Worker');
  for (const name of ['Database', 'ScriptCache']) {
    fs.rmSync(path.join(workerDir, name), { recursive: true, force: true });
  }
}

function extensionPageUrl(extensionDir, page) {
  if (!page) return '';
  const id = extensionIdFromExtensionDir(extensionDir);
  return id ? `chrome-extension://${id}/${page}` : '';
}

// The CDP HTTP paths the launcher reads: the target list, the version, or one
// target to close. CDP target ids are hex or UUIDs.
const CDP_HTTP_PATH = /^\/json\/(?:list|version|close\/[A-Za-z0-9-]+)$/u;
const CDP_TARGET_ID = /^[A-Za-z0-9-]+$/u;
// A child node keeps cdpHttp synchronous. The port and path reach it as argv,
// never as script source, so a path cannot change what it runs.
const CDP_HTTP_SCRIPT = `
const http = require('http');
const [port, pathname] = process.argv.slice(1);
http.get({ host: '127.0.0.1', port: Number(port), path: pathname }, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    process.stdout.write(body);
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  });
}).on('error', () => process.exit(1));
`;

/**
 * GET a CDP HTTP path on 127.0.0.1. Returns the body, or null when the port or
 * path is not one the launcher uses, or the request fails.
 * @param {number} port
 * @param {string} pathname `/json/list`, `/json/version` or `/json/close/<target id>`
 * @returns {string | null}
 */
function cdpHttp(port, pathname) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof pathname !== 'string' || !CDP_HTTP_PATH.test(pathname)) return null;
  const result = spawnSync(process.execPath, ['-e', CDP_HTTP_SCRIPT, String(port), pathname], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * The page targets to close so one `homePage` tab of the extension remains and no
 * disposable blank/new-tab page is left. The kept home tab is the first whose
 * title is set and differs from `defaultTitle` (a slot-stamped tab), else the first.
 * @param {unknown[]} targets CDP /json/list entries.
 * @param {{ extensionId: string, homePage: string, defaultTitle?: string }} options
 * @returns {{ id: string, url: string }[]}
 */
function homeTabsToClose(targets, { extensionId, homePage, defaultTitle }) {
  const pages = targets.filter(
    (target) =>
      target &&
      target.type === 'page' &&
      typeof target.id === 'string' &&
      typeof target.url === 'string',
  );
  const homes = pages.filter(
    (target) =>
      target.url.startsWith(`chrome-extension://${extensionId}/`) &&
      target.url.includes(`/${homePage}`),
  );
  if (homes.length === 0) return [];
  const strays = pages.filter(
    (target) =>
      target.url === 'about:blank' ||
      target.url === 'chrome://newtab/' ||
      target.url.startsWith('chrome://new-tab-page'),
  );
  const keeper =
    homes.find(
      (target) =>
        typeof target.title === 'string' &&
        target.title.trim() !== '' &&
        target.title.trim() !== defaultTitle,
    ) ?? homes[0];
  return [...homes, ...strays]
    .filter((target) => target.id !== keeper.id)
    .map((target) => ({ id: target.id, url: target.url }));
}

// Best effort by design: CDP ownership is already proven and the caller's
// readiness converges home tabs again, so a pruning failure must not fail the
// launch. Every failure is returned so the launch log says why a duplicate tab
// survived instead of hiding it.
/**
 * Close the extra `homePage` tabs and stray blank tabs the browser on `port` has.
 * @param {number} port CDP port on 127.0.0.1.
 * @param {string} extensionDir The unpacked extension, for its id.
 * @param {{ homePage?: string, defaultTitle?: string }} options
 * @returns {string[]} What could not be done, one line each; empty when all went well.
 */
function pruneExtraHomeTabs(port, extensionDir, { homePage, defaultTitle }) {
  if (!homePage) return [];
  const extensionId = extensionIdFromExtensionDir(extensionDir);
  if (!extensionId) return ['extension id unavailable; skipped'];
  const raw = cdpHttp(port, '/json/list');
  if (raw === null) return [`GET http://127.0.0.1:${port}/json/list failed`];
  let targets;
  try {
    targets = JSON.parse(raw);
  } catch (error) {
    return [`/json/list returned malformed JSON: ${error.message}`];
  }
  if (!Array.isArray(targets)) return ['/json/list did not return a target list'];
  const problems = [];
  for (const target of homeTabsToClose(targets, { extensionId, homePage, defaultTitle })) {
    // The id comes from the endpoint's own response: close only a CDP-shaped one.
    if (!CDP_TARGET_ID.test(target.id)) {
      problems.push(
        `skipped target with an invalid id: ${JSON.stringify(target.id)} (${target.url})`,
      );
      continue;
    }
    if (cdpHttp(port, `/json/close/${encodeURIComponent(target.id)}`) === null)
      problems.push(`could not close ${target.url} (${target.id})`);
  }
  return problems;
}

module.exports = { launchBrowser, homeTabsToClose, cdpHttp, pruneExtraHomeTabs };
