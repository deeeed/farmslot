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
  hasDetachedLaunchUnproven,
  isolatedProfileArgs,
  markDetachedLaunchUnproven,
  markValidationPortLaunchUnproven,
  readValidationPortQuarantine,
  remoteDebuggingArgs,
  removeRuntimeIdentity,
  runtimeIdentityArgs,
  validationLaunchQuarantineError,
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
 * @property {(runtimeDir: string) => () => void} [acquireRuntimeLock] Taken before the profile is touched; the returned release runs when the launch ends.
 * @property {string} [rerunCommand] Command named in "Next:" hints.
 * @property {number} [focusSettleMs] macOS: wait before the one focus check (default 1000).
 * @property {(line: string) => void} [log] Progress lines (default stderr).
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
  return opts;
}

function runLaunch(opts, acquireLock) {
  const { cdpPort, profile, extensionDir, runtimeDir, log } = opts;
  const rerun = opts.rerunCommand ? `rerun: ${opts.rerunCommand}` : 'rerun the launch';
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
  if (foreignPids.length > 0) {
    throw new Error(
      `Refusing to launch on CDP port ${cdpPort}: it is held by a browser this harness did not launch (pid ${foreignPids.join(', ')}). ` +
        `Next: pick a free --cdp-port, or stop that browser.`,
    );
  }
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
  const ownedListenerMissing = () =>
    new Error(
      `Chrome launched but did not expose an owned CDP listener on 127.0.0.1:${cdpPort}. ` +
        `Next: inspect ${opts.chromeLog}, then ${rerun}`,
    );
  const logFd = fs.openSync(opts.chromeLog, 'a');
  const previousFrontmost = captureMacFrontmost();
  let browserPid;
  try {
    try {
      beginDetachedLaunch(cdpPort, profile, activeValidationLease);
      if (application) {
        execFileSync('open', macBackgroundOpenArgs(application, chromeArgs), {
          env: sanitizedChildEnv(),
          stdio: ['ignore', logFd, logFd],
        });
        browserPid = waitForOwnedCdpPid(cdpPort, ownedBrowser);
        if (browserPid === null) {
          stopProfileProcessesSync(profile, { waitForAppearanceMs: 400 });
          throw ownedListenerMissing();
        }
      } else {
        const child = spawn(opts.chromeBin, chromeArgs, {
          detached: true,
          env: sanitizedChildEnv(),
          stdio: ['ignore', logFd, logFd],
        });
        child.unref();
        browserPid = waitForOwnedCdpPid(cdpPort, ownedBrowser);
        if (browserPid === null) {
          stopProfileProcessesSync(profile, { extraPids: child.pid ? [child.pid] : [] });
          throw ownedListenerMissing();
        }
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
        `The launch markers for port ${opts.cdpPort} and ${opts.profile} are kept. Next: stop pid ${pid}, then rerun.`,
    );
  }
  clearLaunchMarkers();
  throw new Error(
    `Chrome started but its start window could not be opened: ${openError}. Next: inspect ${opts.chromeLog}, then rerun.`,
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
        `The launch markers for port ${opts.cdpPort} and ${opts.profile} are kept. Next: stop pid ${pid}, then rerun.`,
    );
  }
  clearLaunchMarkers();
  throw new Error(
    `Chrome started but the extension did not load over CDP: ${loadError}. ` +
      `Next: inspect ${opts.chromeLog}, or rerun with RECIPE_HARNESS_BROWSER=cft to use Chrome for Testing.`,
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

function waitForOwnedCdpPid(port, ownedBrowser) {
  for (let i = 0; i < 300; i += 1) {
    const pid = cdpListenerPids(port).find(ownedBrowser);
    if (pid !== undefined) return pid;
    spawnSync('sleep', ['0.1']);
  }
  return null;
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

function extensionPageUrl(extensionDir, page) {
  if (!page) return '';
  const id = extensionIdFromExtensionDir(extensionDir);
  return id ? `chrome-extension://${id}/${page}` : '';
}

function cdpHttp(port, pathname) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const http = require('http');
    http.get('http://127.0.0.1:${Number(port)}${pathname}', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        process.stdout.write(body);
        process.exitCode = res.statusCode === 200 ? 0 : 1;
      });
    }).on('error', () => process.exit(1));
  `,
    ],
    { encoding: 'utf8', timeout: 4000 },
  );
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
    if (cdpHttp(port, `/json/close/${target.id}`) === null)
      problems.push(`could not close ${target.url} (${target.id})`);
  }
  return problems;
}

module.exports = { launchBrowser, homeTabsToClose };
