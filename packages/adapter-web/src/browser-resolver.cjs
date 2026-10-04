#!/usr/bin/env node
// browser-resolver.cjs — choose the Chromium build that hosts an unpacked
// extension, and load it over CDP when that build is branded Chrome.
//
// Chrome for Testing (the Playwright build) honours --load-extension; branded
// Google Chrome 137+ ignores it, so the extension is loaded with the
// browser-level CDP command Extensions.loadUnpacked (needs
// --enable-unsafe-extension-debugging); see browser-cdp.cjs.
//
// RECIPE_HARNESS_BROWSER=auto|cft|chrome|<path> (default auto):
//   auto   reuse the browser recorded for an existing slot profile; otherwise
//          probe-launch Chrome for Testing the way the caller will launch it
//          (cached per OS build, binary and launch mode) and use it when it
//          starts and paints, else branded Chrome.
//   cft    the Playwright Chrome for Testing build, never probed (rollback).
//   chrome branded Google Chrome.
//   <path> that executable.
// RECIPE_HARNESS_CHROME_BIN, when set, wins and is used verbatim (no probe).
// RECIPE_HARNESS_CHROME_CANDIDATES (path-list) overrides where Google Chrome
// is looked for; RECIPE_HARNESS_BROWSER_CACHE overrides the probe cache file.
//
// CLI (stdout carries only the result; diagnostics go to stderr):
//   browser-resolver.cjs resolve --target <checkout>
//     [--launch-method spawn|launch-services] [--display headless|headful]
//     [--recorded <browser-resolution.json>] [--out <file>]... [--json]
//     prints the executable path (or the resolution JSON with --json).
//     Exit 1 when no browser can be selected.
//   browser-resolver.cjs load-unpacked --port <cdp> --path <dist> --profile <dir>
//     [--expect-id <id>] [--open-url <url>] [--timeout-ms <ms>]
//     prints {"id": ...}. Exit 1 on failure (the caller stops the browser).
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const cdp = require('./browser-cdp.cjs');

const SCHEMA_VERSION = 2;
const LOAD_EXTENSION = 'load-extension';
const CDP_LOAD_UNPACKED = 'cdp-load-unpacked';
const UNLAUNCHABLE_MARKER = 'BROWSER_UNLAUNCHABLE:';
// A probe that timed out (slow start, no frame under load) is not a property
// of the binary: it is remembered briefly so back-to-back launches do not pay
// the probe again, then retried.
const TRANSIENT_VERDICT_TTL_MS = 30 * 60 * 1000;
const PROBE_LOCK_STALE_MS = 3 * 60 * 1000;
const CHROME_FOR_TESTING = 'chrome-for-testing';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Branded Chrome refuses --load-extension; these flags let the harness load
// the unpacked build over CDP and keep the isolated profile free of default-
// browser and sync prompts (callers already pass --no-first-run). No second
// --disable-features here: Chrome keeps only the last one on the command line.
const BRANDED_CHROME_ARGS = [
  '--enable-unsafe-extension-debugging',
  '--no-default-browser-check',
  '--disable-sync',
];

function brandedChromeCandidates(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  if (env.RECIPE_HARNESS_CHROME_CANDIDATES)
    return env.RECIPE_HARNESS_CHROME_CANDIDATES.split(path.delimiter).filter(Boolean);
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  if (platform === 'linux')
    return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  return [];
}

function appBundleFor(executable) {
  let current = path.resolve(executable);
  while (current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return null;
}

function plistString(plist, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'u').exec(plist);
  return match ? match[1].trim() : null;
}

// ---- managed Google Chrome ----------------------------------------------------

// Google Chrome on a managed Mac reads policies from these plists; Chrome for
// Testing (another bundle id) does not. Force-installed extensions reach every
// profile, slot profiles included, and some open windows that take the front.
// RECIPE_HARNESS_MANAGED_CHROME_PLISTS (colon-separated, empty for none)
// replaces these paths; the shared test setups set it empty.
function managedChromePlists(env = process.env) {
  if (env.RECIPE_HARNESS_MANAGED_CHROME_PLISTS !== undefined) {
    return env.RECIPE_HARNESS_MANAGED_CHROME_PLISTS.split(':').filter(Boolean);
  }
  const user = env.USER || os.userInfo().username;
  return [
    '/Library/Managed Preferences/com.google.Chrome.plist',
    path.join('/Library/Managed Preferences', user, 'com.google.Chrome.plist'),
  ];
}

// One policy key, or undefined when absent or unreadable. `plutil -extract
// … json` only extracts arrays and dictionaries; a scalar (BrowserSignin: 2,
// ForceBrowserSignin: true) comes out with `raw`.
function readPolicyKey(file, key) {
  const extract = (format) =>
    execFileSync('plutil', ['-extract', key, format, '-o', '-', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  try {
    return JSON.parse(extract('json'));
  } catch {
    // A scalar, or the key is absent: try it as a raw value.
  }
  try {
    const raw = extract('raw').trim();
    if (raw === 'true' || raw === 'false') return raw === 'true';
    return /^-?\d+$/u.test(raw) ? Number(raw) : raw;
  } catch {
    return undefined;
  }
}

// The name an installed copy of an extension declares, from any of the
// operator's own Chrome profiles; best effort, for doctor output only.
function installedExtensionName(id, home = os.homedir()) {
  const root = path.join(home, 'Library/Application Support/Google/Chrome');
  let profiles = [];
  try {
    profiles = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const profile of profiles) {
    const dir = path.join(root, profile, 'Extensions', id);
    let versions = [];
    try {
      versions = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const version of versions) {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(dir, version, 'manifest.json'), 'utf8'),
        );
        const message = /^__MSG_(.+)__$/u.exec(manifest.name ?? '');
        if (!message) return manifest.name ?? null;
        const locale = manifest.default_locale || 'en';
        const messages = JSON.parse(
          fs.readFileSync(path.join(dir, version, '_locales', locale, 'messages.json'), 'utf8'),
        );
        const entry = Object.entries(messages).find(
          ([key]) => key.toLowerCase() === message[1].toLowerCase(),
        );
        return entry?.[1]?.message ?? null;
      } catch {
        // Unreadable manifest: try the next copy.
      }
    }
  }
  return null;
}

// { forcedExtensions: [{ id, name }], signinForced, sources } when Google
// Chrome is managed with force-installed extensions or forced sign-in;
// otherwise null. Only macOS managed preferences are read.
function readManagedChromePolicy({
  platform = process.platform,
  plists = managedChromePlists(),
  exists = (file) => fs.existsSync(file),
  readKey = readPolicyKey,
  extensionName = installedExtensionName,
} = {}) {
  if (platform !== 'darwin') return null;
  const ids = new Set();
  const sources = [];
  let signinForced = false;
  for (const file of plists) {
    if (!exists(file)) continue;
    sources.push(file);
    const forcelist = readKey(file, 'ExtensionInstallForcelist');
    if (Array.isArray(forcelist)) {
      for (const entry of forcelist) {
        const id = String(entry).split(';')[0].trim();
        if (/^[a-p]{32}$/u.test(id)) ids.add(id);
      }
    }
    const settings = readKey(file, 'ExtensionSettings');
    if (settings && typeof settings === 'object') {
      for (const [id, setting] of Object.entries(settings)) {
        if (
          /^[a-p]{32}$/u.test(id) &&
          ['force_installed', 'normal_installed'].includes(setting?.installation_mode)
        )
          ids.add(id);
      }
    }
    if (readKey(file, 'BrowserSignin') === 2 || readKey(file, 'ForceBrowserSignin') === true)
      signinForced = true;
  }
  if (ids.size === 0 && !signinForced) return null;
  return {
    forcedExtensions: [...ids].sort().map((id) => ({ id, name: extensionName(id) })),
    signinForced,
    sources,
  };
}

function describeManagedChrome(managed) {
  const list = managed.forcedExtensions
    .map(({ id, name }) => (name ? `${id} (${name})` : id))
    .join(', ');
  return `Google Chrome is managed by policy (${managed.forcedExtensions.length} forced extension${managed.forcedExtensions.length === 1 ? '' : 's'}${list ? `: ${list}` : ''}${managed.signinForced ? '; browser sign-in forced' : ''})`;
}

function readBundleInfo(executable) {
  const bundle = appBundleFor(executable);
  if (!bundle) return null;
  try {
    const plist = fs.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8');
    return {
      bundleId: plistString(plist, 'CFBundleIdentifier'),
      version: plistString(plist, 'CFBundleShortVersionString'),
    };
  } catch {
    // Binary plist or unreadable bundle: fall back to --version below.
    return null;
  }
}

// Version without launching a browser window: the bundle plist on macOS,
// `--version` elsewhere (it does not start the browser process proper).
function browserVersion(executable) {
  const fromBundle = readBundleInfo(executable)?.version;
  if (fromBundle) return fromBundle;
  try {
    const output = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /(\d+(?:\.\d+){1,3})/u.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}

// Branded Google Chrome (any channel) ignores --load-extension since 137.
// Chrome for Testing, Chromium, Brave and other builds still honour it.
function isBrandedChrome(executable) {
  const bundleId = readBundleInfo(executable)?.bundleId;
  if (bundleId) return /^com\.google\.Chrome(\.|$)/u.test(bundleId);
  return (
    /^google-chrome(-stable|-beta|-unstable)?$/u.test(path.basename(executable)) ||
    executable === '/opt/google/chrome/chrome'
  );
}

function browserKind(executable) {
  const bundleId = readBundleInfo(executable)?.bundleId ?? '';
  if (
    /^com\.google\.chrome\.for\.testing$/iu.test(bundleId) ||
    /Google Chrome for Testing/u.test(executable)
  ) {
    return CHROME_FOR_TESTING;
  }
  if (isBrandedChrome(executable)) return 'google-chrome';
  return 'other';
}

function extensionLoadingFor(executable) {
  return isBrandedChrome(executable) ? CDP_LOAD_UNPACKED : LOAD_EXTENSION;
}

function describeBrowser(executable) {
  return {
    bin: executable,
    browser: browserKind(executable),
    version: browserVersion(executable),
    extensionLoading: extensionLoadingFor(executable),
  };
}

// Extra launch arguments for the chosen loading method. Branded Chrome must
// not get --disable-extensions-except: it disables the CDP-loaded extension.
function extensionLaunchArgs(extensionDir, extensionLoading) {
  if (extensionLoading === CDP_LOAD_UNPACKED) {
    // --load-extension is ignored by branded Chrome but kept on the command
    // line: runtime ownership checks match the loaded dist by this flag.
    return [...BRANDED_CHROME_ARGS, `--load-extension=${extensionDir}`];
  }
  return [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
}

function browserMode(env = process.env) {
  const raw = String(env.RECIPE_HARNESS_BROWSER ?? '').trim();
  if (raw === '' || raw === 'auto') return { mode: 'auto' };
  if (raw === 'cft' || raw === 'chrome') return { mode: raw };
  if (path.isAbsolute(raw)) return { mode: 'path', path: raw };
  throw new Error(
    `RECIPE_HARNESS_BROWSER must be auto, cft, chrome, or an absolute executable path (got ${JSON.stringify(raw)}).`,
  );
}

function defaultCachePath(env = process.env) {
  if (env.RECIPE_HARNESS_BROWSER_CACHE) return path.resolve(env.RECIPE_HARNESS_BROWSER_CACHE);
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'farmslot', 'browser-probe.json');
}

// How the caller starts the browser decides whether Chrome for Testing
// survives on macOS 26+: as a direct child of a terminal process it can die
// with SIGBUS in ImageIO, while the same build started through Launch Services
// (`open -n -g -a`, the Extension launcher's path) runs. The probe therefore
// launches the way, and in the display mode, its caller will.
const SPAWN = 'spawn';
const LAUNCH_SERVICES = 'launch-services';
const HEADLESS = 'headless';
const HEADFUL = 'headful';

function effectiveLaunchMethod(executable, launchMethod, platform = process.platform) {
  return launchMethod === LAUNCH_SERVICES && platform === 'darwin' && appBundleFor(executable)
    ? LAUNCH_SERVICES
    : SPAWN;
}

// One probe verdict per OS build + binary (path, version, size, mtime) +
// launch method + display mode. The cache file lives in this user's home, so
// it is per machine without keying on a hostname that can change.
function probeCacheKey(executable, version, launchMethod = SPAWN, display = HEADLESS) {
  let stat = null;
  try {
    stat = fs.statSync(executable);
  } catch {
    // Missing binary: the key still differs from any installed one.
  }
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        executable: path.resolve(executable),
        version,
        launchMethod,
        display,
        size: stat?.size ?? null,
        mtimeMs: stat ? Math.trunc(stat.mtimeMs) : null,
      }),
    )
    .digest('hex');
}

function readProbeCache(cachePath) {
  try {
    const value = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return value &&
      value.schemaVersion === SCHEMA_VERSION &&
      value.entries &&
      typeof value.entries === 'object'
      ? value
      : { schemaVersion: SCHEMA_VERSION, entries: {} };
  } catch {
    return { schemaVersion: SCHEMA_VERSION, entries: {} };
  }
}

function writeProbeCache(cachePath, key, verdict) {
  const cache = readProbeCache(cachePath);
  cache.entries[key] = verdict;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, cachePath);
}

function usableVerdict(verdict, nowMs) {
  if (!verdict) return null;
  if (verdict.transient && !(Date.parse(verdict.expiresAt) > nowMs)) return null;
  return verdict;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readTicket(ticketPath) {
  try {
    const text = fs.readFileSync(ticketPath, 'utf8');
    const { mtimeMs } = fs.statSync(ticketPath);
    let holder = null;
    try {
      holder = JSON.parse(text);
    } catch {
      // Empty or half-written: judged by its age below.
    }
    return { mtimeMs, holder };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// A ticket no longer holds the lock once it is released, its holder is dead,
// its pid now belongs to a process with another start time (read fresh with
// `ps` on every judgement, within `budgetMs`, with the same 2s slack as the CDP
// ownership check), or it is older than PROBE_LOCK_STALE_MS; an unreadable
// ticket is judged by its file age. A start time that cannot be read in time
// leaves the ticket held.
const { START_TIME_SLACK_MS } = cdp;

function ticketFree(
  dir,
  number,
  { nowMs = Date.now(), budgetMs = 30000, readStartTime = startTimeOf } = {},
) {
  if (number === 0 || fs.existsSync(path.join(dir, `${number}.released`))) return true;
  const ticket = readTicket(path.join(dir, String(number)));
  if (!ticket) return true;
  const { holder } = ticket;
  if (holder && Number.isInteger(holder.pid) && Number.isFinite(holder.at)) {
    if (!pidAlive(holder.pid) || nowMs - holder.at > PROBE_LOCK_STALE_MS) return true;
    if (typeof holder.started !== 'string' || holder.pid === process.pid || budgetMs <= 0)
      return false;
    const started = readStartTime(holder.pid, budgetMs);
    if (started === null) return false;
    const drift = Math.abs(Date.parse(`${started} UTC`) - Date.parse(`${holder.started} UTC`));
    return Number.isFinite(drift) && drift > START_TIME_SLACK_MS;
  }
  return nowMs - ticket.mtimeMs > PROBE_LOCK_STALE_MS;
}

// `ps` start time (UTC), or null when it cannot be read within `timeoutMs`.
function startTimeOf(pid, timeoutMs) {
  try {
    return cdp.processStartTime(pid, undefined, timeoutMs ? { timeoutMs } : {});
  } catch {
    return null;
  }
}

function newestTicket(dir) {
  let newest = 0;
  for (const name of fs.readdirSync(dir)) {
    if (/^\d+$/u.test(name)) newest = Math.max(newest, Number(name));
  }
  return newest;
}

// One probe per cache key at a time across processes: the first resolver
// probes and writes, the others wait and read its verdict. The lock is a
// directory of numbered tickets and the holder is the creator of the newest
// one. Ticket n+1 is created exclusively, only after ticket n was seen free,
// and no ticket is ever moved or removed, so a live holder is never displaced
// whatever the interleaving: of two resolvers that both judged ticket n free,
// one creates n+1 and the other waits on it. A holder older than
// PROBE_LOCK_STALE_MS counts as gone, so a probe that outlives it can overlap
// the next one. The directory grows by two small files per probe; a crashed
// holder's unreleased ticket stays, judged free once its holder is gone.
// `beforeClaim` and `readStartTime` are test seams.
async function withProbeLock(
  cachePath,
  key,
  fn,
  { waitMs = 150000, beforeClaim = null, readStartTime = startTimeOf } = {},
) {
  const dir = `${cachePath}.${key.slice(0, 16)}.locks`;
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  const timedOut = () => new Error(`Timed out waiting for the browser probe lock ${dir}.`);
  let mine = null;
  let fd = null;
  for (;;) {
    const newest = newestTicket(dir);
    if (ticketFree(dir, newest, { budgetMs: deadline - Date.now(), readStartTime })) {
      if (beforeClaim) await beforeClaim(newest);
      if (Date.now() > deadline) throw timedOut();
      try {
        fd = fs.openSync(path.join(dir, String(newest + 1)), 'wx', 0o600);
        mine = newest + 1;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        continue;
      }
    }
    if (Date.now() > deadline) throw timedOut();
    await sleep(Math.max(1, Math.min(250, deadline - Date.now())));
  }
  // From here the ticket is ours: whatever happens, it is released.
  try {
    try {
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, at: Date.now(), started: readStartTime(process.pid) }),
      );
    } finally {
      fs.closeSync(fd);
    }
    return await fn();
  } finally {
    fs.writeFileSync(path.join(dir, `${mine}.released`), '', { mode: 0o600 });
  }
}

// Probes in flight, so a CLI watchdog can stop their browsers before exiting.
const activeProbeProfiles = new Set();

function profilePids(profile) {
  try {
    return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${profile}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function killProfile(profile) {
  for (const pid of profilePids(profile)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
}

// `--version` succeeds even for a build that crashes at startup, so a browser
// is accepted only when a start answers on DevTools, paints a frame, and
// survives a settle without dying. The Chrome for Testing crash on macOS 26+
// lands 2-5s after DevTools opens, so the settle is several times that.
// Verdicts: ok, or died (both properties of the binary, cached), or transient
// (no DevTools / no frame in time: retried after TRANSIENT_VERDICT_TTL_MS).
// Worst case is about startupMs + 2 render attempts + settleMs (~80s).
async function probeLaunch(
  executable,
  {
    launchMethod = SPAWN,
    display = HEADLESS,
    settleMs = 15000,
    startupMs = 30000,
    renderAttempts = 2,
  } = {},
) {
  const method = effectiveLaunchMethod(executable, launchMethod);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-browser-probe-'));
  activeProbeProfiles.add(profile);
  const startedAt = Date.now();
  const verdict = (ok, reason, transient = false) => ({
    ok,
    reason,
    transient,
    launchMethod: method,
    display,
    durationMs: Date.now() - startedAt,
  });
  let child = null;
  let exited = null;
  try {
    const port = await freePort();
    // A headful probe starts like the slot browsers (the launchers and the
    // library autolaunch): in the background with no startup window (Chrome
    // activates itself when it opens one); renderCheck opens a background
    // window. Like the launchers, it keeps a window behind the operator's apps
    // rendering.
    const backgroundWindow = display === HEADFUL;
    const args = [
      ...(display === HEADLESS ? ['--headless=new'] : ['--window-size=480,360']),
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      backgroundWindow ? '--no-startup-window' : 'about:blank',
    ];
    if (method === LAUNCH_SERVICES) {
      execFileSync('open', ['-g', '-n', '-a', appBundleFor(executable), '--args', ...args], {
        stdio: 'ignore',
        timeout: 15000,
      });
    } else {
      child = spawn(executable, args, { detached: true, stdio: 'ignore' });
      child.on('exit', (code, signal) => {
        exited = signal ?? `code ${code}`;
      });
      child.on('error', (error) => {
        exited = `spawn failed: ${error.message}`;
      });
    }
    const alive = () =>
      method === LAUNCH_SERVICES ? profilePids(profile).length > 0 : exited === null;
    const died = (when) =>
      verdict(
        false,
        `exited ${when}${exited ? ` (${exited})` : ''}`,
        String(exited).startsWith('spawn failed'),
      );
    let up = false;
    while (!up && Date.now() - startedAt < startupMs) {
      if (exited) return died('during startup');
      up = await devtoolsAnswers(port);
      if (!up) {
        if (method === LAUNCH_SERVICES && Date.now() - startedAt > 5000 && !alive())
          return died('during startup');
        await sleep(250);
      }
    }
    if (!up)
      return alive()
        ? verdict(false, `no DevTools endpoint within ${startupMs}ms`, true)
        : died('during startup');
    let render = null;
    for (let attempt = 1; attempt <= renderAttempts && !render?.ok; attempt += 1) {
      render = await renderCheck(port);
      if (!alive()) return died('after DevTools started');
    }
    if (!render.ok) return verdict(false, `${render.reason} (${renderAttempts} attempts)`, true);
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      if (!alive()) return died('after DevTools started');
      await sleep(250);
    }
    if (await devtoolsAnswers(port)) return verdict(true, 'started and rendered');
    // Only a proven exit is a property of the binary.
    return alive()
      ? verdict(false, 'DevTools stopped answering after the settle', true)
      : died('after DevTools started');
  } catch (error) {
    return verdict(false, `launch failed: ${error.message}`, true);
  } finally {
    try {
      if (child?.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
    killProfile(profile);
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
    activeProbeProfiles.delete(profile);
  }
}

// A build can start and answer on DevTools yet never paint (seen with Chrome
// for Testing on macOS 26+, and under heavy load): rAF never fires and
// screenshots hang. Require one animation frame and one screenshot; every
// step has a deadline (about 15s per attempt).
async function renderCheck(port) {
  let client = null;
  try {
    client = await cdp.connectBrowserCdp(port, { timeoutMs: 5000, commandTimeoutMs: 3000 });
    const { targetInfos } = await client.send('Target.getTargets', {});
    const page = targetInfos.find((target) => target.type === 'page');
    const targetId = page
      ? page.targetId
      : (await cdp.openBackgroundWindow(client.send, 'about:blank', 3000)).targetId;
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client
      .send(
        'Runtime.evaluate',
        {
          expression: 'new Promise((resolve) => requestAnimationFrame(() => resolve(true)))',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
        6000,
      )
      .catch((error) => {
        throw Object.assign(new Error('renders no frames (requestAnimationFrame never fired)'), {
          cause: error,
        });
      });
    const shot = await client.send('Page.captureScreenshot', {}, sessionId, 6000).catch((error) => {
      throw Object.assign(new Error('renders no frames (screenshot did not complete)'), {
        cause: error,
      });
    });
    if (!shot?.data) return { ok: false, reason: 'renders no frames (empty screenshot)' };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error.message.startsWith('renders no frames')
        ? error.message
        : `render check failed: ${error.message}`,
    };
  } finally {
    client?.close();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = require('node:net').createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function devtoolsAnswers(port) {
  try {
    return (
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    ).ok;
  } catch {
    return false;
  }
}

function playwrightChromiumExecutable(target) {
  const requireFromTarget = createRequire(path.join(path.resolve(target), 'package.json'));
  let chromium = null;
  for (const name of ['@playwright/test', 'playwright']) {
    try {
      chromium = requireFromTarget(name).chromium;
      if (chromium) break;
    } catch {
      // Optional Playwright package unavailable; try the next package name.
    }
  }
  if (!chromium) {
    return {
      error:
        '[recipe-harness] Playwright is not available from this checkout; install dependencies first, or set RECIPE_HARNESS_CHROME_BIN to an explicitly approved browser.',
    };
  }
  let executable = '';
  try {
    executable = chromium.executablePath();
  } catch (error) {
    return {
      error: `[recipe-harness] Could not resolve Playwright Chromium executable: ${error?.message ?? error}. Manual approval required before installing the Playwright Chromium browser cache (no package.json changes); ask the user before running yarn playwright install chromium.`,
    };
  }
  if (!fs.existsSync(executable)) {
    return {
      error:
        `[recipe-harness] Playwright Chromium is not installed at ${executable}. Manual approval required before installing the Playwright Chromium browser cache (no package.json changes). Ask the user for approval; if they agree, run: cd ${shellQuote(path.resolve(target))} && yarn playwright install chromium\n` +
        '[recipe-harness] To use a browser that is already installed, set RECIPE_HARNESS_CHROME_BIN=/path/to/chrome explicitly.',
    };
  }
  return { executable };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function firstExisting(candidates, exists) {
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

function resolutionError(message, resolution = {}) {
  return Object.assign(new Error(message), { resolution });
}

function readRecorded(file) {
  if (!file) return null;
  try {
    const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
    return recorded && typeof recorded.bin === 'string' ? recorded : null;
  } catch {
    return null;
  }
}

// Resolve the browser for one launch. Inputs are injectable for tests:
// cft() returns { executable } or { error }; probe(bin, options) returns a
// verdict. `recorded` names the browser-resolution.json of an existing slot
// profile: auto keeps that kind of browser (see below).
async function resolveBrowser({
  env = process.env,
  cft,
  probe = probeLaunch,
  cachePath = defaultCachePath(env),
  chromeCandidates = brandedChromeCandidates(env),
  exists = (file) => fs.existsSync(file),
  describe = describeBrowser,
  now = () => new Date(),
  launchMethod = SPAWN,
  display = HEADLESS,
  recorded = null,
  managedChrome = readManagedChromePolicy,
} = {}) {
  // `selection` is the rule that picked the binary; a profile created by an
  // explicit choice keeps that rule across later auto launches. A binary from
  // the checkout's Playwright build is Chrome for Testing by its source, not by
  // its path (Linux builds live under chrome-linux/).
  const finish = (bin, source, extra = {}) => ({
    schemaVersion: SCHEMA_VERSION,
    ...describe(bin),
    source,
    resolvedAt: now().toISOString(),
    ...extra,
  });

  if (env.RECIPE_HARNESS_CHROME_BIN) {
    const bin = env.RECIPE_HARNESS_CHROME_BIN;
    if (!exists(bin))
      throw resolutionError(
        `[recipe-harness] RECIPE_HARNESS_CHROME_BIN is not an executable file: ${bin}`,
      );
    return finish(bin, 'RECIPE_HARNESS_CHROME_BIN', { mode: 'override', selection: 'override' });
  }

  const { mode, path: explicit } = browserMode(env);
  if (mode === 'path') {
    if (!exists(explicit))
      throw resolutionError(
        `[recipe-harness] RECIPE_HARNESS_BROWSER is not an executable file: ${explicit}`,
      );
    return finish(explicit, 'RECIPE_HARNESS_BROWSER', { mode, selection: mode });
  }
  const chrome = () => firstExisting(chromeCandidates, exists);
  if (mode === 'chrome') {
    const bin = chrome();
    if (!bin)
      throw resolutionError(
        `[recipe-harness] RECIPE_HARNESS_BROWSER=chrome but Google Chrome is not installed (looked in: ${chromeCandidates.join(', ')}).`,
      );
    return finish(bin, 'RECIPE_HARNESS_BROWSER', { mode, selection: mode });
  }

  if (mode === 'cft') {
    const cftResult = cft();
    if (cftResult.error) throw resolutionError(cftResult.error);
    return finish(cftResult.executable, 'RECIPE_HARNESS_BROWSER', {
      mode,
      selection: mode,
      browser: CHROME_FOR_TESTING,
    });
  }

  // auto. A slot profile keeps the kind of browser it was created with:
  // - created on Google Chrome or an explicit browser: that binary, as long
  //   as it exists (never silently back to Chrome for Testing);
  // - created on Chrome for Testing: the checkout's current Chrome for
  //   Testing (so a Playwright upgrade is followed), moving to Google Chrome
  //   only once that build is proven to die (a probe timeout keeps it).
  // A fresh profile takes Chrome for Testing when it starts and paints.
  const previous = readRecorded(recorded);
  // Names for forced extensions the slot browser already reported (the
  // operator's own Chrome profiles may not be readable).
  const knownNames = new Map(
    ['policyPinned', 'disabled']
      .flatMap((group) => previous?.launch?.otherExtensions?.[group] ?? [])
      .map(({ id, name }) => [id, name]),
  );
  const managedPolicy = () => {
    const policy = managedChrome();
    if (!policy) return null;
    return {
      ...policy,
      forcedExtensions: policy.forcedExtensions.map((entry) => ({
        ...entry,
        name: entry.name ?? knownNames.get(entry.id) ?? null,
      })),
    };
  };
  const recordedFrom = previous ? path.resolve(recorded) : null;
  const recordedKind = previous ? (previous.browser ?? describe(previous.bin).browser) : null;
  const recordedSelection = previous ? (previous.selection ?? previous.mode ?? 'auto') : null;
  // override/path: chosen by env; explicit: a launcher given --chrome-bin directly.
  const followsCft =
    Boolean(previous) &&
    recordedKind === CHROME_FOR_TESTING &&
    !['override', 'path', 'explicit'].includes(recordedSelection);
  if (previous && !followsCft) {
    if (!exists(previous.bin)) {
      throw resolutionError(
        `[recipe-harness] This slot profile was created with ${recordedKind} at ${previous.bin}, which no longer exists. ` +
          'Next: reinstall it, reset the slot profile, or choose a browser with RECIPE_HARNESS_BROWSER.',
      );
    }
    const managedNow = recordedKind === 'google-chrome' ? managedPolicy() : null;
    return finish(previous.bin, 'auto-recorded', {
      mode,
      selection: recordedSelection,
      ...(recordedKind ? { browser: recordedKind } : {}),
      ...(managedNow
        ? {
            managedChrome: managedNow,
            warning:
              `${describeManagedChrome(managedNow)} and this slot profile was created on it, so forced extensions may open windows that take the front. ` +
              'Next: reset the slot profile to move the slot to Chrome for Testing.',
          }
        : {}),
      recordedFrom,
      recordedAt: previous.resolvedAt ?? null,
    });
  }

  // An uninstalled Playwright build keeps today's approval-gated install
  // guidance; only a build that is installed but cannot start falls back.
  const cftResult = cft();
  if (cftResult.error) throw resolutionError(cftResult.error);
  const cftBin = cftResult.executable;
  const version = browserVersion(cftBin);
  const method = effectiveLaunchMethod(cftBin, launchMethod);
  const key = probeCacheKey(cftBin, version, method, display);
  const nowMs = () => now().getTime();
  const lineage = previous ? { recordedFrom, recordedBin: previous.bin, recordedSelection } : {};

  let cached = true;
  let verdict = usableVerdict(readProbeCache(cachePath).entries[key], nowMs());
  if (!verdict) {
    verdict = await withProbeLock(cachePath, key, async () => {
      const settled = usableVerdict(readProbeCache(cachePath).entries[key], nowMs());
      if (settled) return settled;
      cached = false;
      const result = await probe(cftBin, { launchMethod: method, display });
      const checkedAt = now();
      const fresh = {
        ok: result.ok,
        reason: result.reason,
        transient: Boolean(result.transient),
        durationMs: result.durationMs,
        bin: cftBin,
        version,
        launchMethod: method,
        display,
        checkedAt: checkedAt.toISOString(),
        ...(result.transient
          ? { expiresAt: new Date(checkedAt.getTime() + TRANSIENT_VERDICT_TTL_MS).toISOString() }
          : {}),
      };
      try {
        writeProbeCache(cachePath, key, fresh);
      } catch (error) {
        process.stderr.write(
          `[browser] could not write probe cache ${cachePath}: ${error.message}\n`,
        );
      }
      return fresh;
    });
  }
  const probeRecord = {
    bin: cftBin,
    version,
    launchMethod: method,
    display,
    ok: verdict.ok,
    reason: verdict.reason,
    transient: Boolean(verdict.transient),
    checkedAt: verdict.checkedAt,
    ...(verdict.expiresAt ? { expiresAt: verdict.expiresAt } : {}),
    cached,
    cachePath,
  };
  // On a Mac whose Google Chrome is managed (forced extensions or sign-in),
  // slots use Chrome for Testing, and never fall back to that managed Chrome.
  const managed = managedPolicy();
  const managedExtra = managed ? { reason: 'managed-chrome', managedChrome: managed } : {};
  // A followed CfT profile keeps the rule it was created by (cft or auto).
  const asCft = {
    mode,
    selection: previous ? recordedSelection : 'auto',
    browser: CHROME_FOR_TESTING,
    ...managedExtra,
  };
  if (verdict.ok)
    return finish(cftBin, previous ? 'auto-recorded' : 'auto', {
      ...asCft,
      probe: probeRecord,
      ...lineage,
    });
  if (previous && verdict.transient) {
    return finish(cftBin, 'auto-recorded', {
      ...asCft,
      probe: probeRecord,
      ...lineage,
      warning: `Chrome for Testing probe did not complete (${verdict.reason}); the profile keeps Chrome for Testing until a probe proves it dies.`,
    });
  }
  if (managed) {
    throw resolutionError(
      `${UNLAUNCHABLE_MARKER} ${describeManagedChrome(managed)}, so slots use Chrome for Testing, and Chrome for Testing ${version ?? ''} did not start and paint here (${verdict.reason}). ` +
        'Next: either set RECIPE_HARNESS_BROWSER=chrome to use the managed Google Chrome and accept that its forced extensions may open windows that take the front, ' +
        "or reduce the machine's load and retry (a probe that only timed out is retried after 30 minutes).",
      { probe: probeRecord, managedChrome: managed },
    );
  }
  const fallback = chrome();
  if (!fallback) {
    throw resolutionError(
      `${UNLAUNCHABLE_MARKER} Chrome for Testing ${version ?? ''} does not start on this machine (${verdict.reason}) and Google Chrome is not installed. ` +
        'Next: install Google Chrome, or set RECIPE_HARNESS_CHROME_BIN to a browser that starts.',
      { probe: probeRecord },
    );
  }
  return finish(fallback, 'auto', {
    mode,
    selection: 'auto',
    probe: probeRecord,
    ...lineage,
    fallbackReason: `Chrome for Testing probe failed: ${verdict.reason}`,
  });
}

// ---- CLI -------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = { out: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      args.json = true;
      continue;
    }
    if (!flag.startsWith('--') || index + 1 >= argv.length)
      throw new Error(`Missing value for ${flag}`);
    const key = flag.slice(2);
    if (key === 'out') args.out.push(argv[index + 1]);
    else args[key] = argv[index + 1];
    index += 1;
  }
  return args;
}

function writeResolution(files, resolution) {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(resolution, null, 2)}\n`);
  }
}

// Outer bound for one CLI call. The probe stays well inside it; if anything
// still hangs, stop the probe browsers before giving up.
const CLI_DEADLINE_MS = 120000;

const USAGE =
  'Usage: browser-resolver.cjs resolve --target <checkout> [--launch-method spawn|launch-services] [--display headless|headful] [--recorded <file>] [--out <file>] [--json] | load-unpacked --port <cdp> --path <dist> --profile <dir> [--expect-id <id>] [--open-url <url>] [--timeout-ms <ms>] | open-window --port <cdp> --url <url>';

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const args = parseCliArgs(rest);
  const watchdog = setTimeout(() => {
    for (const profile of activeProbeProfiles) {
      killProfile(profile);
      fs.rmSync(profile, { recursive: true, force: true });
    }
    process.stderr.write(
      `browser-resolver ${command} did not finish within ${CLI_DEADLINE_MS}ms.\n`,
    );
    process.exit(1);
  }, CLI_DEADLINE_MS);
  watchdog.unref();
  if (command === 'resolve') {
    const target = path.resolve(args.target || process.cwd());
    const resolution = await resolveBrowser({
      cft: () => playwrightChromiumExecutable(target),
      launchMethod: args['launch-method'] === LAUNCH_SERVICES ? LAUNCH_SERVICES : SPAWN,
      display: args.display === HEADFUL ? HEADFUL : HEADLESS,
      recorded: args.recorded || null,
    });
    writeResolution(args.out, resolution);
    process.stderr.write(
      `[browser] ${resolution.browser} ${resolution.version ?? '?'} via ${resolution.source}/${resolution.mode}; extension loading: ${resolution.extensionLoading}${resolution.fallbackReason ? ` (${resolution.fallbackReason})` : ''}\n`,
    );
    process.stdout.write(args.json ? `${JSON.stringify(resolution)}\n` : resolution.bin);
    return;
  }
  if (command === 'load-unpacked') {
    if (!args.port || !args.path || !args.profile)
      throw new Error('load-unpacked requires --port, --path and --profile');
    const timeoutMs = Math.min(Number(args['timeout-ms'] || 60000), CLI_DEADLINE_MS - 15000);
    const loaded = await cdp.loadUnpackedOverPort(Number(args.port), args.path, {
      profile: args.profile,
      ...(args['expect-id'] ? { expectedId: args['expect-id'] } : {}),
      url: args['open-url'] || null,
      timeoutMs,
    });
    process.stdout.write(`${JSON.stringify(loaded)}\n`);
    return;
  }
  if (command === 'open-window') {
    if (!args.port || !args.url) throw new Error('open-window requires --port and --url');
    const client = await cdp.connectBrowserCdp(Number(args.port), { timeoutMs: 15000 });
    try {
      const { targetId } = await cdp.openBackgroundWindow(client.send, args.url, 15000);
      process.stdout.write(`${JSON.stringify({ targetId })}\n`);
    } finally {
      client.close();
    }
    return;
  }
  throw new Error(USAGE);
}

// CLI entry, exported so a host can keep its own script path (process identity, manifests).
function runCli(argv = process.argv.slice(2)) {
  main(argv).then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}

module.exports = {
  BRANDED_CHROME_ARGS,
  CDP_LOAD_UNPACKED,
  HEADFUL,
  HEADLESS,
  LAUNCH_SERVICES,
  LOAD_EXTENSION,
  SPAWN,
  TRANSIENT_VERDICT_TTL_MS,
  UNLAUNCHABLE_MARKER,
  assertCdpOwnedByProfile: cdp.assertCdpOwnedByProfile,
  cdpListenerPids: cdp.cdpListenerPids,
  cdpOwner: cdp.cdpOwner,
  waitForCdpOwner: cdp.waitForCdpOwner,
  brandedChromeCandidates,
  browserMode,
  browserVersion,
  connectBrowserCdp: cdp.connectBrowserCdp,
  defaultCachePath,
  describeBrowser,
  effectiveLaunchMethod,
  expectedExtensionId: cdp.expectedExtensionId,
  extensionLaunchArgs,
  extensionLoadingFor,
  isBrandedChrome,
  loadUnpackedExtension: cdp.loadUnpackedExtension,
  loadUnpackedOverPort: cdp.loadUnpackedOverPort,
  playwrightChromiumExecutable,
  probeCacheKey,
  probeLaunch,
  readProbeCache,
  renderCheck,
  resolveBrowser,
  withProbeLock,
  readManagedChromePolicy,
  managedChromePlists,
  runCli,
};

if (require.main === module) runCli();
