#!/usr/bin/env node
// launch.mjs — start (or reuse) the web-dapp slot browser and its wallet host.
//
// Purpose:
//   One Chromium-family browser per slot, bound to 127.0.0.1:<cdp-port>, with a
//   profile under <runtime>/<adapter id>/. signer=extension loads a wallet
//   extension and seeds the fixture account through the extension signer hook
//   (lib/signers.mjs: prepareProfile, then afterBrowserStart); this launcher
//   knows no wallet product. signer=injected loads no extension; the wallet host
//   provides the strict test wallet. Either way wallet-host.mjs then records
//   wallet requests.
//
// Inputs (flags): --target <checkout> --cdp-port <port> --app-port <port>
//   [--signer extension|injected] [--signer-module <path>] [--account <fixture name>]
//   [--fresh-profile] [--headless | --headful] [--slow-mo <ms>] [--start-chain <id>]
//   [--json] [--network mainnet --mainnet-confirmation REAL_FUNDS] (testnet
//   otherwise, enforced in the browser from the venue policy)
//   env: TERMINAL_CHROME_BIN, RECIPE_WEB_DAPP_SIGNER_MODULE, RECIPE_WALLET_FIXTURE,
//   TERMINAL_HEADLESS, TERMINAL_SLOW_MO, TERMINAL_WINDOW, TERMINAL_SCREEN
//   (plus whatever the signer module reads)
//   The browser is headful by default, in a window placed per slot (see
//   lib/display.mjs); --headless or TERMINAL_HEADLESS=1 hides it.
// Outputs: <runtime>/<adapter id>/browser.json (+ pid files, logs); JSON summary on stdout.
//   Exit 0 ready; 1 launch/seed failure; 2 usage.
// Never prints: mnemonics, private keys, the wallet password.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostResolverRules } from './lib/blocked-hosts.mjs';
import { browserWebSocketUrl, CdpClient } from './lib/cdp-client.mjs';
import {
  browserDisplayArgs,
  resolveHeadless,
  resolveSlowMo,
  windowPlacement,
  writeProfileZoom,
} from './lib/display.mjs';
import { clearHudState } from './lib/hud.mjs';
import {
  cdpListenerPids,
  ownedBrowserPids,
  ownerMarker,
  ownsProcess,
  pidAlive,
  stopWebDappBrowser,
  terminate,
} from './lib/processes.mjs';
import { assertLaunchNetwork, devServerTestnetDiagnostic } from './lib/readiness.mjs';
import {
  fixtureEntry,
  loadWalletFixture,
  resolveSigner,
  viemAccountFromEntry,
  webDappPolicy,
  webDappRuntimeDir,
} from './lib/runtime.mjs';
import { defaultSigner, loadSigners, SIGNER_MODULE_ENV } from './lib/signers.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const macosFocus = createRequire(import.meta.url)('../macos-focus.cjs');

function usage() {
  return 'Usage: launch.mjs --target <checkout> --cdp-port <port> --app-port <port> [--signer extension|injected] [--signer-module <path>] [--account <name>] [--fresh-profile] [--headless | --headful] [--slow-mo <ms>] [--network testnet|mainnet --mainnet-confirmation REAL_FUNDS] [--start-chain <id>] [--json]';
}

export function parseLaunchArgs(argv, env = process.env) {
  const args = {
    account: 'dev1',
    'fresh-profile': false,
    headless: false,
    headful: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (
      flag === '--fresh-profile' ||
      flag === '--headless' ||
      flag === '--headful' ||
      flag === '--json'
    ) {
      args[flag.slice(2)] = true;
      continue;
    }
    if (!flag.startsWith('--') || index + 1 >= argv.length)
      throw Object.assign(new Error(usage()), { exitCode: 2 });
    args[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  for (const key of ['target', 'cdp-port', 'app-port']) {
    if (!args[key]) throw Object.assign(new Error(`Missing --${key}\n${usage()}`), { exitCode: 2 });
  }
  args.signer = resolveSigner(args.signer, defaultSigner(args['signer-module'], env));
  if (args.headless && args.headful)
    throw Object.assign(new Error(`--headless and --headful are mutually exclusive\n${usage()}`), {
      exitCode: 2,
    });
  return args;
}

function log(message) {
  process.stderr.write(`[${webDappPolicy().adapterId}/launch] ${message}\n`);
}

function browserStarts(bin) {
  try {
    const version = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return version || null;
  } catch {
    return null;
  }
}

// The slot browser is Chrome for Testing (Playwright's cache, newest build),
// launched through LaunchServices on macOS, where a direct spawn of it
// crashes. TERMINAL_CHROME_BIN is the only explicit
// override. No other browser is picked on its own: an ad-blocking browser
// (Brave Shields) changes the app's network behaviour and its console.
export function chromeForTestingCandidates(
  home = os.homedir(),
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== 'darwin') return [];
  const cache = path.join(home, 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return [];
  const folder = arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac';
  return readdirSync(cache)
    .filter((entry) => /^chromium-\d+$/u.test(entry))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((entry) =>
      path.join(
        cache,
        entry,
        folder,
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    );
}

// Only TERMINAL_CHROME_BIN overrides Chrome for Testing. The shared
// RECIPE_HARNESS_CHROME_BIN is ignored here: a farm default pointing at a
// browser that blocks requests itself (Brave) would make diagnostics lie.
export async function resolveBrowser(env = process.env, candidates = chromeForTestingCandidates()) {
  const explicit = env.TERMINAL_CHROME_BIN;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`TERMINAL_CHROME_BIN does not exist: ${explicit}`);
    return { bin: explicit, version: browserStarts(explicit), source: 'TERMINAL_CHROME_BIN' };
  }
  if (env.RECIPE_HARNESS_CHROME_BIN)
    log(
      `ignoring RECIPE_HARNESS_CHROME_BIN (${env.RECIPE_HARNESS_CHROME_BIN}) for the ${webDappPolicy().adapterId}; set TERMINAL_CHROME_BIN to override Chrome for Testing`,
    );
  const bin = candidates.find((candidate) => existsSync(candidate));
  if (bin) return { bin, version: browserStarts(bin), source: 'chrome-for-testing' };
  throw new Error(
    'Chrome for Testing is not installed (Playwright cache).\n' +
      'Next: npx playwright install chromium, or set TERMINAL_CHROME_BIN to a Chromium-family browser that honours --load-extension.',
  );
}

// How the browser process is started, named as the shared browser resolver
// names them. An .app browser on macOS starts through LaunchServices in the
// background (`open -g -n -a`), as the Extension launcher does: a visible one
// never takes the operator's keyboard focus, and Chrome for Testing does not
// start when spawned directly on this macOS. A binary outside an .app bundle,
// or any browser elsewhere, is spawned directly.
export const SPAWN = 'spawn';
export const LAUNCH_SERVICES = 'launch-services';

export function macApplicationForExecutable(executable) {
  let current = path.resolve(executable);
  while (current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return null;
}

export function launchMethodFor(executable, { platform = process.platform } = {}) {
  return platform === 'darwin' && macApplicationForExecutable(executable) ? LAUNCH_SERVICES : SPAWN;
}

// LaunchServices hands back no child: the browser's pid is the process that
// listens on the slot CDP port with this slot's profile.
async function launchInBackground(
  application,
  browserArgs,
  { runtime, cdpPort, logFile, pidFile, timeoutMs },
) {
  const out = openSync(logFile, 'a');
  try {
    execFileSync('open', macosFocus.macBackgroundOpenArgs(application, browserArgs), {
      stdio: ['ignore', out, out],
      timeout: 30000,
    });
  } finally {
    closeSync(out);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = cdpListenerPids(cdpPort).find((candidate) =>
      ownsProcess('browser', candidate, runtime),
    );
    if (pid) {
      writeFileSync(pidFile, `${pid}\n`);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const pid of ownedBrowserPids(runtime)) await terminate(pid, 3000);
  throw new Error(
    `${path.basename(application)} started but no browser on this slot's profile listened on CDP ${cdpPort} within ${timeoutMs}ms.`,
  );
}

// Focus decisions go to <runtime>/focus.log as well as stderr, so a run's
// focus behaviour can be read back after the fact.
const FOCUS_OUTCOMES = {
  restored: (previous) =>
    `our browser was in front; restored ${previous.name} (pid ${previous.pid}) once`,
  kept: (previous) =>
    `our browser was not in front, or ${previous?.name ?? 'the previous app'} could not be activated; left alone`,
  off: () => 'focus handling is off, or no app was captured before the launch',
};

// The one focus check after a launch (@farmslot/adapter-web/macos-focus): the app in
// front before the launch gets the front back, once, by its pid, only if one
// of this slot's browser processes (by owner marker, never by bundle) is in
// front.
export function checkFocusAfterLaunch(
  runtime,
  previous,
  { ourPids = ownedBrowserPids(runtime), focus = macosFocus } = {},
) {
  const outcome = focus.restoreFrontmostIfOurs(previous, ourPids);
  focusLog(runtime, FOCUS_OUTCOMES[outcome](previous));
  return outcome;
}

function focusLog(runtime, message) {
  log(`focus: ${message}`);
  try {
    appendFileSync(path.join(runtime, 'focus.log'), `${new Date().toISOString()} ${message}\n`, {
      mode: 0o600,
    });
  } catch {
    // The log is advisory.
  }
}

// Browser-level CDP helpers for a background launch.
async function withBrowserClient(cdpPort, callback) {
  const client = await CdpClient.connect(await browserWebSocketUrl(cdpPort, 15000));
  try {
    return await callback(client);
  } finally {
    client.close?.();
  }
}

export function backgroundWindowParams(url, placement) {
  return {
    url,
    newWindow: true,
    background: true,
    ...(placement
      ? { left: placement.x, top: placement.y, width: placement.width, height: placement.height }
      : {}),
  };
}

async function openBackgroundWindow(cdpPort, url, placement) {
  return withBrowserClient(cdpPort, (client) =>
    client.send('Target.createTarget', backgroundWindowParams(url, placement)),
  );
}

function focusSettleMs(env) {
  const value = Number(env.MM_HARNESS_FOCUS_SETTLE_MS);
  return Number.isFinite(value) && value >= 0 ? value : 1000;
}

// Resolves once the process is running, rejects on a spawn failure (EACCES,
// ENOENT) so the caller's rollback runs; only a running pid is recorded.
export function spawnDetached(command, args, { logFile, pidFile, env = process.env }) {
  const out = openSync(logFile, 'a');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', out, out], env });
    } catch (error) {
      closeSync(out);
      reject(error);
      return;
    }
    child.once('error', (error) => {
      closeSync(out);
      reject(
        new Error(`could not start ${path.basename(command)}: ${error.code ?? error.message}`),
      );
    });
    child.once('spawn', () => {
      closeSync(out);
      child.unref();
      try {
        writeFileSync(pidFile, `${child.pid}\n`);
      } catch (error) {
        // Without a pid file nothing could stop this child later: stop it now.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
        reject(
          new Error(
            `could not record ${path.basename(command)} pid in ${pidFile}: ${error.code ?? error.message}`,
          ),
        );
        return;
      }
      resolve(child.pid);
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not happen within ${timeoutMs}ms`);
}

function readStateFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Write through a fresh temporary file and an atomic rename, owner-only.
export function writePrivateFile(file, text) {
  // A failed write or rename must not leave key material in the temporary file.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// The host is ready once the app's first document has loaded with its hooks,
// which waits for a cold dev-server compile.
export const LAUNCH_TIMEOUTS = Object.freeze({ browserStartMs: 90000, hostReadyMs: 180000 });

// The venue policy comes from RECIPE_WEB_DAPP_POLICY (webDappPolicy), as for every web-dapp leaf.
// The signer hooks (lib/signers.mjs) come from the module --signer-module or
// RECIPE_WEB_DAPP_SIGNER_MODULE names, the same one the wallet host loads.
/**
 * @param {Record<string, any>} args the parsed launch flags (see `parseLaunchArgs`)
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ timeouts?: { browserStartMs: number, hostReadyMs: number } }} [options]
 */
export async function launchWebDappBrowser(
  args,
  env = process.env,
  { timeouts = LAUNCH_TIMEOUTS } = {},
) {
  const policy = webDappPolicy(env);
  const signerModule = args['signer-module'] ?? env[SIGNER_MODULE_ENV];
  const signerHooks = await loadSigners({
    ...env,
    ...(signerModule ? { [SIGNER_MODULE_ENV]: signerModule } : {}),
  });
  if (args.signer === 'extension' && !signerHooks.extension?.prepareProfile) {
    throw new Error(
      'signer=extension needs an extension signer: pass --signer-module <path> or set RECIPE_WEB_DAPP_SIGNER_MODULE.',
    );
  }
  // Without confirm the wallet host sees no wallet surface, and its startup
  // sweep would close the extension's own side panel or popup tabs.
  if (args.signer === 'extension' && !signerHooks.extension.confirm) {
    throw new Error(
      'the extension signer must provide confirm: without it the wallet host cannot tell the wallet surfaces from app tabs and would close them.',
    );
  }
  const target = path.resolve(args.target);
  const cdpPort = Number(args['cdp-port']);
  const appPort = Number(args['app-port']);
  const signer = args.signer;
  // Mainnet needs the real-funds confirmation. Testnet is enforced inside the
  // browser: the SDK's mainnet venue hosts are unresolvable for the whole
  // browser, and the wallet host blocks, logs and refuses anything mainnet.
  const network = assertLaunchNetwork(target, {
    network: args.network,
    mainnetConfirmation: args['mainnet-confirmation'],
  });
  const venues = network === 'testnet' ? policy.venueHosts(target) : { blocked: [], served: [] };
  const mainnetHosts = venues.blocked;
  // The served-network check is skipped only when the policy says so for this
  // checkout (venueHosts() returns servedCheck: 'not-applicable', for an app whose
  // page makes no venue requests of its own). An empty served list without it
  // keeps the check, which then fails closed: a policy that computes its served
  // hosts can't drop the check by finding none.
  const servedNotApplicable = network === 'testnet' && venues.servedCheck === 'not-applicable';
  if (servedNotApplicable && venues.served.length > 0) {
    throw new Error(
      `the venue policy for ${target} lists served testnet hosts and servedCheck: 'not-applicable'; declare one or the other.`,
    );
  }
  // What the running browser enforces; a browser enforcing anything else is
  // never reused (its resolver rules are fixed at start).
  const enforcementFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        network,
        mainnetHosts,
        testnetHosts: venues.served,
        // Only when opted out, so a policy that keeps the check fingerprints as
        // before; a browser whose wallet host skips the check is never reused for
        // a launch that needs it.
        ...(servedNotApplicable ? { servedCheck: 'not-applicable' } : {}),
      }),
    )
    .digest('hex')
    .slice(0, 16);
  const devServer =
    network === 'testnet'
      ? devServerTestnetDiagnostic(target, { appPort, variable: policy.testnetVariable })
      : null;
  if (devServer && !(devServer.known && devServer.forced)) {
    log(
      `WARN dev server testnet check: ${devServer.detail} (advisory; the browser enforces testnet itself)`,
    );
  }
  const runtime = webDappRuntimeDir(target);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  chmodSync(runtime, 0o700);
  const stateFile = path.join(runtime, 'browser.json');
  const appOrigin = `http://localhost:${appPort}`;
  const headless = resolveHeadless({ headless: args.headless, headful: args.headful, env });
  const slowMoMs = resolveSlowMo({ flag: args['slow-mo'], env });

  const { fixture } = await loadWalletFixture(target, env);
  const accountAddress = viemAccountFromEntry(fixtureEntry(fixture, args.account), target).address;

  const previous = readStateFile(stateFile);
  const reusable =
    previous &&
    !args['fresh-profile'] &&
    previous.signer === signer &&
    previous.cdpPort === cdpPort &&
    previous.appOrigin === appOrigin &&
    previous.account?.name === args.account &&
    previous.browser?.headless === headless &&
    (previous.network ?? 'testnet') === network &&
    previous.networkEnforcement?.fingerprint === enforcementFingerprint &&
    ownsProcess('browser', previous.browserPid, runtime) &&
    ownsProcess('wallet-host', previous.hostPid, runtime);
  if (reusable) {
    await browserWebSocketUrl(cdpPort, 5000);
    log(`reusing browser pid ${previous.browserPid} (${signer}, ${args.account})`);
    const state = { ...previous, slowMoMs };
    if (previous.slowMoMs !== slowMoMs)
      writePrivateFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    return { ...state, reused: true };
  }
  await stopWebDappBrowser(target, { cdpPort, log });

  const browser = await resolveBrowser(env);
  const profile = path.join(
    runtime,
    `profile-${signer}-${args.account.replace(/[^A-Za-z0-9_-]/gu, '_')}`,
  );
  if (args['fresh-profile'] && existsSync(profile)) {
    const retired = `${profile}.retired-${Date.now()}`;
    renameSync(profile, retired);
    rmSync(retired, { recursive: true, force: true });
  }
  const freshProfile = !existsSync(profile);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const placement = headless ? null : windowPlacement({ cdpPort, env });
  // Reset on every start so a profile reused across modes never keeps a zoom.
  writeProfileZoom(profile, placement?.zoom ?? 1);

  const browserArgs = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...browserDisplayArgs({ headless, placement }),
    ownerMarker('browser', runtime),
    ...(network === 'testnet' ? [hostResolverRules(mainnetHosts)] : []),
  ];

  // Key material (the slot fixture) and the encrypted vault (fixture state)
  // never outlive this call; anything started here is stopped again when a
  // later step fails.
  const secrets = [];
  const trackSecret = (file) => {
    secrets.push(file);
    return file;
  };
  let started = false;
  const launchMethod = launchMethodFor(browser.bin);
  // Focus is checked for a visible browser started in the background.
  const guardFocus = launchMethod === LAUNCH_SERVICES && !headless;
  // With no startup window, windows are created over CDP at these bounds; a
  // headless browser keeps the tall viewport the recipes were proven on.
  const windowBounds = placement ?? { x: 0, y: 0, width: 1600, height: 2400 };
  let application = null;
  let previousFrontmost = null;
  try {
    let extension = null;
    if (signer === 'extension') {
      extension = await signerHooks.extension.prepareProfile({
        target,
        runtime,
        profile,
        account: args.account,
        fixture,
        env,
        freshProfile,
        log,
        writePrivateFile,
        trackSecret,
      });
      if (
        !extension ||
        typeof extension !== 'object' ||
        (extension.browserArgs !== undefined && !Array.isArray(extension.browserArgs)) ||
        (extension.secrets !== undefined && !Array.isArray(extension.secrets)) ||
        (extension.state !== undefined &&
          (extension.state === null || typeof extension.state !== 'object'))
      ) {
        throw new Error(
          'signer module prepareProfile must return { browserArgs, secrets, state } (browserArgs and secrets arrays, state an object; afterBrowserStart optional).',
        );
      }
      secrets.push(...(extension.secrets ?? []));
      browserArgs.push(...(extension.browserArgs ?? []));
    }
    // A background launch opens no window at startup: Chrome activates itself
    // when its first window appears. Windows are created over CDP instead, in
    // the background.
    browserArgs.push(launchMethod === LAUNCH_SERVICES ? '--no-startup-window' : 'about:blank');

    started = true;
    // Where this browser's console begins in the slot capture, for
    // assert_no_console_errors.
    // With the file's inode: a replaced file is then read from its start.
    const consoleStats = Object.fromEntries(
      ['page', 'extension'].map((source) => {
        const file = path.join(
          runtime,
          source === 'page' ? 'app-console.log' : 'extension-console.log',
        );
        return [source, existsSync(file) ? statSync(file) : null];
      }),
    );
    const consoleOffsets = {
      page: consoleStats.page?.size ?? 0,
      extension: consoleStats.extension?.size ?? 0,
      inodes: {
        page: consoleStats.page?.ino ?? null,
        extension: consoleStats.extension?.ino ?? null,
      },
    };
    application =
      launchMethod === LAUNCH_SERVICES ? macApplicationForExecutable(browser.bin) : null;
    if (guardFocus) {
      // Only recorded: the browser never activates itself, and the one check
      // after the launch (finally) uses this to undo an activation by ours.
      previousFrontmost = macosFocus.captureMacFrontmost();
      focusLog(
        runtime,
        `front app before the launch: ${previousFrontmost?.name ?? 'unknown'} (pid ${previousFrontmost?.pid ?? '-'})`,
      );
    }
    const browserPid =
      launchMethod === LAUNCH_SERVICES
        ? await launchInBackground(application, browserArgs, {
            runtime,
            cdpPort,
            logFile: path.join(runtime, 'browser.log'),
            pidFile: path.join(runtime, 'browser.pid'),
            timeoutMs: timeouts.browserStartMs,
          })
        : await spawnDetached(browser.bin, browserArgs, {
            logFile: path.join(runtime, 'browser.log'),
            pidFile: path.join(runtime, 'browser.pid'),
            env,
          });
    await browserWebSocketUrl(cdpPort, timeouts.browserStartMs);
    log(
      `browser pid ${browserPid} on CDP ${cdpPort} (${browser.version ?? browser.bin}, ${headless ? 'headless' : `window ${placement.width}x${placement.height}+${placement.x}+${placement.y} zoom ${placement.zoom}`})`,
    );

    let extensionHostArgs = [];
    let extensionState = extension?.state ?? null;
    if (extension?.afterBrowserStart) {
      const after = await extension.afterBrowserStart({
        cdpPort,
        launchMethod,
        windowBounds,
        withBrowserClient: (callback) => withBrowserClient(cdpPort, callback),
        openBackgroundWindow: (url) => openBackgroundWindow(cdpPort, url, windowBounds),
        log,
        trackSecret,
      });
      extensionHostArgs = after?.hostArgs ?? [];
      extensionState = { ...extensionState, ...after?.state };
    }

    rmSync(path.join(runtime, 'wallet-host.ready'), { force: true });
    // A new browser starts without a HUD; the runner's next update draws one.
    clearHudState(runtime);
    const hostArgs = [
      path.join(SCRIPT_DIR, 'wallet-host.mjs'),
      '--cdp-port',
      String(cdpPort),
      '--runtime-dir',
      runtime,
      '--signer',
      signer,
      '--app-origin',
      appOrigin,
      '--target',
      target,
      '--account',
      args.account,
      '--start-chain',
      String(args['start-chain'] ?? policy.startChain),
      '--network',
      network,
      ownerMarker('wallet-host', runtime),
    ];
    if (network === 'testnet')
      hostArgs.push(
        '--mainnet-hosts',
        mainnetHosts.join(','),
        '--testnet-hosts',
        venues.served.join(','),
        ...(servedNotApplicable ? ['--served-check', 'not-applicable'] : []),
      );
    hostArgs.push(...extensionHostArgs);
    if (signerModule) hostArgs.push('--signer-module', signerModule);
    if (guardFocus) hostArgs.push('--observe-focus', '1');
    if (launchMethod === LAUNCH_SERVICES)
      hostArgs.push(
        '--window',
        [windowBounds.x, windowBounds.y, windowBounds.width, windowBounds.height].join(','),
      );
    const hostPid = await spawnDetached(process.execPath, hostArgs, {
      logFile: path.join(runtime, 'wallet-host.log'),
      pidFile: path.join(runtime, 'wallet-host.pid'),
      env,
    });
    await waitFor(
      () => {
        if (existsSync(path.join(runtime, 'wallet-host.ready'))) return true;
        if (!pidAlive(hostPid))
          throw new Error(
            `wallet host exited before it was ready (see ${path.join(runtime, 'wallet-host.log')})`,
          );
        return false;
      },
      timeouts.hostReadyMs,
      'wallet host ready',
    );
    // A window can activate the browser when it first paints, after the
    // browser already answers: check once after that (MM_HARNESS_FOCUS_SETTLE_MS).
    if (guardFocus) await new Promise((resolve) => setTimeout(resolve, focusSettleMs(env)));

    const state = {
      schemaVersion: 1,
      signer,
      network,
      networkEnforcement:
        network === 'testnet'
          ? {
              mode: 'enforced',
              mainnetHosts,
              testnetHosts: venues.served,
              fingerprint: enforcementFingerprint,
              ...(servedNotApplicable ? { served: 'not-applicable' } : {}),
              layers: [
                'host-resolver-rules',
                'cdp-fetch-block',
                'wallet-refusal',
                ...(servedNotApplicable ? [] : ['served-network-check']),
              ],
            }
          : {
              mode: 'disabled',
              reason: 'network=mainnet with mainnet_confirmation=REAL_FUNDS',
              fingerprint: enforcementFingerprint,
            },
      devServerDiagnostic: devServer,
      consoleOffsets,
      // The app port's listeners at ready; wallet-surface actions re-check them
      // (lsof only sees this user's sockets).
      appListeners: cdpListenerPids(appPort),
      cdpPort,
      appOrigin,
      account: { name: args.account, address: accountAddress },
      browserPid,
      hostPid,
      browser: {
        bin: browser.bin,
        version: browser.version,
        source: browser.source,
        headless,
        launchMethod,
      },
      window: placement,
      slowMoMs,
      profile,
      freshProfile,
      extension: extensionState,
      startedAt: new Date().toISOString(),
    };
    writePrivateFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    return { ...state, reused: false };
  } catch (error) {
    if (started) {
      log(
        `launch failed, stopping what it started: ${String(error?.message ?? error).split('\n')[0]}`,
      );
      await stopWebDappBrowser(target, { cdpPort, log }).catch((stopError) =>
        log(`rollback incomplete: ${stopError.message}`),
      );
      for (const pid of ownedBrowserPids(runtime)) await terminate(pid, 3000);
    }
    throw error;
  } finally {
    for (const file of secrets) rmSync(file, { force: true });
    if (guardFocus) checkFocusAfterLaunch(runtime, previousFrontmost);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseLaunchArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode ?? 2);
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  try {
    const state = await launchWebDappBrowser(args);
    process.stdout.write(
      `${JSON.stringify({ status: 'pass', ...state }, null, args.json ? 0 : 2)}\n`,
    );
  } catch (error) {
    const message = String(error?.stderr ?? '').trim() || error.message;
    process.stdout.write(
      `${JSON.stringify({ status: 'fail', error: message.replace(/0x[0-9a-fA-F]{64}/gu, '<redacted>') })}\n`,
    );
    process.exit(1);
  }
}
