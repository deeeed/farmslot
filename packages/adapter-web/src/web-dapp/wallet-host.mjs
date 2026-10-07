#!/usr/bin/env node
// wallet-host.mjs — long-running observer (and, in injected mode, signer) for the
// web-dapp slot browser.
//
// Purpose:
//   Attaches to the slot browser over CDP and, for every app document, installs
//   the request-log page script before page scripts run. The app tab is created
//   blank, hooked, and only then navigated to the app, so the first app
//   document already has the log binding; ready is written only after that is
//   verified on the committed app document. Appends one JSON line
//   per wallet request to <runtime>/wallet-requests.jsonl. In extension mode it
//   also logs every wallet confirmation window the extension signer's `confirm`
//   hook (lib/signers.mjs) recognises as opened. In injected mode
//   it answers the page's EIP-1193 requests with the strict test wallet signing
//   as the fixture account. It also redraws the recipe HUD (<runtime>/hud.json)
//   on app pages after navigations and whenever the HUD state changes.
//
// Inputs (flags): --cdp-port <port> --runtime-dir <dir> --signer <extension|injected>
//   --app-origin <url> [--extension-id <id>] [--signer-module <path>]
//   [--target <checkout> --account <name> --start-chain <id>] (injected mode only)
//   [--observe-focus 1] (a visible browser launched in the background on macOS:
//   the host records in focus.log if a wallet notification window brought it to
//   front; it never activates an app)
// Outputs: <runtime>/wallet-requests.jsonl, <runtime>/wallet-host.ready, stderr log.
//   Exits when the browser connection closes.
// Never logs: key material, request params, messages, signatures.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  createStrictWallet,
  createWalletRequestBinding,
  pageReadyExpression,
  pageScriptSource,
} from '../dapp/index.cjs';
import { isAppUrl as isExactAppUrl, shortUrl } from '../origin.cjs';

import { hostOf, isBlockedUrl } from './lib/blocked-hosts.mjs';
import { browserWebSocketUrl, CdpClient } from './lib/cdp-client.mjs';
import { hudFile, hudRenderExpression, readHudState } from './lib/hud.mjs';
import { ownedBrowserPids } from './lib/processes.mjs';
import { fixtureAccount, webDappPolicy } from './lib/runtime.mjs';
import { injectedWalletIdentity, loadSigners, SIGNER_MODULE_ENV } from './lib/signers.mjs';

const { captureMacFrontmost, macFocusDisabled } = createRequire(import.meta.url)(
  '../macos-focus.cjs',
);

function usage() {
  return 'Usage: wallet-host.mjs --cdp-port <port> --runtime-dir <dir> --signer <extension|injected> --app-origin <url> [--network testnet|mainnet] [--mainnet-hosts <h1,h2>] [--testnet-hosts <h1,h2>] [--extension-id <id>] [--signer-module <path>] [--target <checkout> --account <name> --start-chain <id>] [--observe-focus 1] [--window x,y,w,h] [--start-path <path>] [--mm-harness-owner=<marker>]';
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (flag.startsWith('--') && flag.includes('=')) {
      args[flag.slice(2, flag.indexOf('='))] = flag.slice(flag.indexOf('=') + 1);
      continue;
    }
    if (!flag.startsWith('--') || index + 1 >= argv.length) throw new Error(usage());
    args[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  for (const key of ['cdp-port', 'runtime-dir', 'signer', 'app-origin']) {
    if (!args[key]) throw new Error(`Missing --${key}\n${usage()}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
// The venue policy (e.g. the Terminal plugin's policy.mjs), from RECIPE_WEB_DAPP_POLICY:
// link hosts, the probe, the typed-data refusal, the start page and chain.
const policy = webDappPolicy();
const LINK_HOSTS = new Set(policy.linkHosts);
const runtimeDir = path.resolve(args['runtime-dir']);
const logFile = path.join(runtimeDir, 'wallet-requests.jsonl');
const signer = args.signer;
const appOrigin = args['app-origin'].replace(/\/$/u, '');
// Testnet runs are held to testnet here too: requests to the mainnet venue
// hosts are failed and logged, and a mainnet typed-data action is refused.
const network = args.network === 'mainnet' ? 'mainnet' : 'testnet';
const mainnetHosts =
  network === 'testnet'
    ? String(args['mainnet-hosts'] ?? '')
        .split(',')
        .filter(Boolean)
    : [];
if (network === 'testnet' && mainnetHosts.length === 0)
  throw new Error('testnet mode needs --mainnet-hosts (the venue hosts to block).');
// The testnet venue endpoints the served-network check looks for: API hosts
// only, never a link host (app.hyperliquid-testnet.xyz serves pages and icons).
const testnetHosts = String(args['testnet-hosts'] ?? '')
  .split(',')
  .filter((host) => host && !LINK_HOSTS.has(host));
// A policy that declares no served hosts (an app whose page makes no venue
// requests of its own) has no served network to check: the served-network check
// is not applicable, and the record says so. Mainnet blocking is unaffected.
const servedApplicable =
  String(args['testnet-hosts'] ?? '')
    .split(',')
    .filter(Boolean).length > 0;
const PROBE_MARK = 'mm-harness-probe=1';
// A testnet run never lets the typed data the policy refuses reach the signer.
const refuseTypedData = network === 'testnet' ? policy.refuseTypedData : null;
// The signer module (lib/signers.mjs): the extension signer's hooks and, under
// `injected.identity`, how the injected strict wallet presents itself.
const signerHooks = await loadSigners({
  ...process.env,
  ...(args['signer-module'] ? { [SIGNER_MODULE_ENV]: args['signer-module'] } : {}),
});
// How the injected strict wallet presents itself (see injectedWalletIdentity).
const INJECTED_WALLET = injectedWalletIdentity(signerHooks);

// The request log is evidence; keep it owner-only even when it already exists.
if (existsSync(logFile)) chmodSync(logFile, 0o600);

function appendEntry(entry) {
  appendFileSync(logFile, `${JSON.stringify({ signer, ...entry })}\n`, { mode: 0o600 });
}

function say(message) {
  process.stderr.write(`${new Date().toISOString()} [wallet-host] ${message}\n`);
}

let wallet = null;
if (signer === 'injected') {
  if (!args.target || !args.account)
    throw new Error('injected mode requires --target and --account');
  const account = await fixtureAccount(path.resolve(args.target), args.account);
  wallet = createStrictWallet({
    account,
    chainId: Number(args['start-chain'] ?? policy.startChain),
  });
  say(
    `injected strict wallet ready for ${args.account} (${account.address}) on chain ${wallet.chainId}`,
  );
}

const source = pageScriptSource({
  signer,
  appOrigin,
  refuseTypedData,
  injectedWallet: INJECTED_WALLET,
});
const client = await CdpClient.connect(await browserWebSocketUrl(Number(args['cdp-port'])));
// Judges each binding call against the frame and document that made it, logs
// it and, in injected mode, answers it with the strict wallet.
const binding = createWalletRequestBinding({
  client,
  appOrigin,
  signer,
  wallet,
  refuseTypedData,
  record: appendEntry,
  say,
});
// Hooks are installed once per target: a second session for the same tab
// (auto-attach plus a restored tab) would log every request twice.
const hookedTargets = new Map();
const appSessions = new Set();
// Per app session: its target id (= main frame id) and the URL its top frame
// has committed.
const sessionTargets = new Map();
const sessionCommittedUrls = new Map();
// App sessions whose target runs with domains enabled; the HUD is drawn only
// there so no evaluate ever waits on a tab paused for setup.
const hudSessions = new Set();

// New tabs start blank before they navigate to the app.
function isAppUrl(url) {
  return url === 'about:blank' || url === '' || isExactAppUrl(url, appOrigin);
}

// The extension signer's view of its own confirmation surfaces (its `confirm`
// hook, from signerHooks above): which tab URLs are the wallet's, and what each
// one is showing. Without the hook no tab counts as a wallet surface.

// A wallet notification or popup window opens as a new window and can
// activate the browser. The host only observes this: it records in
// <runtime>/focus.log when one of this slot's browser processes (by pid, never
// by app bundle) is the frontmost app after such a window opens, and never
// activates any app. Only for a visible background launch (--observe-focus).
const focus =
  args['observe-focus'] === '1' && !macFocusDisabled()
    ? {
        observe(surface, product = 'wallet') {
          const front = captureMacFrontmost();
          if (front && ownedBrowserPids(runtimeDir).includes(front.pid)) {
            appendFileSync(
              path.join(runtimeDir, 'focus.log'),
              `${new Date().toISOString()} slot browser (pid ${front.pid}) is frontmost after a ${product} ${surface} window opened (observed only)\n`,
              { mode: 0o600 },
            );
          }
        },
      }
    : null;

const confirmations =
  signer === 'extension' && signerHooks.extension?.confirm
    ? signerHooks.extension.confirm({ args, appendEntry, say, focus })
    : null;

function isWalletSurfaceUrl(url) {
  return confirmations?.isWalletSurfaceUrl(url) ?? false;
}

function observeWalletSurface(targetId, url) {
  confirmations?.observe(targetId, url);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// Each CDP call is bounded so a slow browser can never leave a new tab paused.
function bounded(promise, label, ms = 10000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Register the binding and the document script first: neither needs the
// target running, while Runtime.enable/Page.enable can wait on a target that is
// paused for the debugger. Enable the domains only after the caller resumed it.
async function installAppHooks(sessionId, targetId) {
  appSessions.add(sessionId);
  sessionTargets.set(sessionId, targetId);
  await bounded(binding.install(sessionId, targetId), 'Runtime.addBinding');
  await bounded(
    client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source, runImmediately: true },
      sessionId,
    ),
    'Page.addScriptToEvaluateOnNewDocument',
  );
  if (network === 'testnet') {
    await bounded(
      client.send(
        'Fetch.enable',
        {
          patterns: mainnetHosts.map((host) => ({ urlPattern: `*://${host}/*` })),
        },
        sessionId,
      ),
      'Fetch.enable',
    );
  }
}

// Venue traffic per app session: the served-network check. Only venue
// endpoints count (the block list and the testnet endpoints); other hosts on a
// venue domain, such as the coin icons on app.hyperliquid.xyz, are ignored.
const venueTraffic = new Map();
function recordVenueTraffic(sessionId, url) {
  const host = hostOf(url);
  if (!host || String(url).includes(PROBE_MARK)) return;
  const side = mainnetHosts.includes(host)
    ? 'mainnet'
    : testnetHosts.includes(host)
      ? 'testnet'
      : null;
  if (!side) return;
  const traffic = venueTraffic.get(sessionId) ?? { testnet: new Set(), mainnet: new Set() };
  traffic[side].add(host);
  venueTraffic.set(sessionId, traffic);
}

// How the launch probes failed. The HTTP probe must have been failed by this
// host (Fetch.failRequest, which Chrome reports as net::ERR_BLOCKED_BY_CLIENT
// with the blocked reason inspector or other). A probe to the same host on a
// port the request block does not match must fail with the resolver rule's
// net::ERR_NAME_NOT_RESOLVED: the rule maps the host for every port and
// transport, so the WebSocket probe failing too is the resolver's doing. Any
// other failure (CORS, another blocker) does not prove the block. WebSocket
// error texts are kept as evidence; Chrome sometimes reports them empty.
const RESOLVER_PROBE_PORT = 444;
const probeRequests = new Map();
const probeFailures = { http: [], resolver: [], websocket: [] };
let probeFailedHere = false;

async function enableAppDomains(sessionId) {
  await bounded(client.send('Runtime.enable', {}, sessionId), 'Runtime.enable');
  await bounded(client.send('Page.enable', {}, sessionId), 'Page.enable');
  if (network === 'testnet')
    await bounded(client.send('Network.enable', {}, sessionId), 'Network.enable');
  const { frameTree } = await bounded(
    client.send('Page.getFrameTree', {}, sessionId),
    'Page.getFrameTree',
  );
  if (frameTree?.frame?.url !== undefined) {
    sessionCommittedUrls.set(sessionId, frameTree.frame.url);
    binding.commit(sessionId, frameTree.frame.url, frameTree.frame.loaderId);
  }
  if (appSessions.has(sessionId)) hudSessions.add(sessionId);
  binding.drain(sessionId);
}

// Redraw the HUD on app pages. The expression is a no-op when the same state
// is already drawn or the page is not on the app origin.
async function drawHud(sessions = hudSessions) {
  const expression = hudRenderExpression(readHudState(runtimeDir), appOrigin);
  await Promise.all(
    [...sessions].map((sessionId) =>
      bounded(
        client.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId),
        'HUD draw',
        3000,
      ).catch(() => {}),
    ),
  );
}

client.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
  const { targetId } = targetInfo;
  const isApp =
    targetInfo.type === 'page' && isAppUrl(targetInfo.url) && !hookedTargets.has(targetId);
  let hooked;
  if (isApp) {
    hooked = deferred();
    hookedTargets.set(targetId, { sessionId, ready: hooked.promise });
  }
  try {
    if (isApp) await installAppHooks(sessionId, targetId);
    else if (targetInfo.type === 'page') observeWalletSurface(targetId, targetInfo.url);
  } catch (error) {
    // A tab whose hooks did not all install is not an app tab: its requests
    // would go unrecorded (or unblocked). The app tab's own failure fails ready.
    say(`setup failed for ${targetInfo.url}: ${error.message}`);
    appSessions.delete(sessionId);
    hooked?.reject(error);
  } finally {
    if (waitingForDebugger)
      await bounded(
        client.send('Runtime.runIfWaitingForDebugger', {}, sessionId),
        'runIfWaitingForDebugger',
      ).catch((error) => say(error.message));
    if (!appSessions.has(sessionId))
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
  if (isApp && appSessions.has(sessionId)) {
    try {
      await enableAppDomains(sessionId);
      say(`attached app page ${targetInfo.url || '(blank)'}`);
      hooked.resolve(sessionId);
    } catch (error) {
      say(`enable failed for ${targetInfo.url}: ${error.message}`);
      hooked.reject(error);
    }
  } else if (hooked) {
    hooked.reject(new Error(`app hooks were not installed on ${targetInfo.url || 'a blank tab'}`));
  }
});

client.on('Target.targetInfoChanged', ({ targetInfo }) => {
  if (targetInfo.type === 'page') observeWalletSurface(targetInfo.targetId, targetInfo.url);
});
client.on('Target.targetCreated', ({ targetInfo }) => {
  if (targetInfo.type === 'page') observeWalletSurface(targetInfo.targetId, targetInfo.url);
});
client.on('Target.detachedFromTarget', ({ sessionId }) => {
  binding.detach(sessionId);
  const targetId = sessionTargets.get(sessionId);
  if (targetId && hookedTargets.get(targetId)?.sessionId === sessionId)
    hookedTargets.delete(targetId);
  appSessions.delete(sessionId);
  hudSessions.delete(sessionId);
  sessionTargets.delete(sessionId);
  sessionCommittedUrls.delete(sessionId);
});
// What the app tab's first navigation did, for the diagnostic when it never
// commits: main-frame commits, and the document's response or failure.
const appNavigation = { commits: [], document: null };
client.on('Network.responseReceived', ({ type, response }, sessionId) => {
  if (sessionId === appNavigation.session && type === 'Document')
    appNavigation.document = `HTTP ${response.status} for ${pathOf(response.url)}`;
});
client.on('Network.loadingFailed', ({ type, errorText, canceled }, sessionId) => {
  if (sessionId === appNavigation.session && type === 'Document')
    appNavigation.document = `load failed: ${errorText}${canceled ? ' (canceled)' : ''}`;
});
client.on('Page.frameNavigated', ({ frame }, sessionId) => {
  if (sessionId === appNavigation.session && !frame.parentId)
    appNavigation.commits.push(pathOf(frame.url));
  if (appSessions.has(sessionId) && !frame.parentId) {
    sessionCommittedUrls.set(sessionId, frame.url);
    binding.commit(sessionId, frame.url, frame.loaderId);
  }
});
client.on('Fetch.requestPaused', ({ requestId, request, resourceType }, sessionId) => {
  const mainnet = isBlockedUrl(request.url, mainnetHosts);
  if (mainnet) {
    appendEntry({
      kind: 'blocked-mainnet',
      t: Date.now(),
      transport: 'http',
      url: shortUrl(request.url),
      resourceType,
      probe: request.url.includes(PROBE_MARK),
    });
    say(`blocked a mainnet request to ${shortUrl(request.url)}`);
  }
  const command = mainnet
    ? client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId)
    : client.send('Fetch.continueRequest', { requestId }, sessionId);
  command.then(
    () => {
      if (mainnet && request.url.includes(PROBE_MARK)) probeFailedHere = true;
    },
    () => {},
  );
});
client.on('Network.requestWillBeSent', ({ requestId, request }, sessionId) => {
  if (request.url.includes(PROBE_MARK))
    probeRequests.set(
      requestId,
      new URL(request.url).port === String(RESOLVER_PROBE_PORT) ? 'resolver' : 'http',
    );
  recordVenueTraffic(sessionId, request.url);
});
client.on('Network.loadingFailed', ({ requestId, errorText, blockedReason }) => {
  const kind = probeRequests.get(requestId);
  if (kind === 'http' || kind === 'resolver')
    probeFailures[kind].push({ errorText, blockedReason: blockedReason ?? null });
});
client.on('Network.webSocketFrameError', ({ requestId, errorMessage }) => {
  if (probeRequests.get(requestId) === 'websocket')
    probeFailures.websocket.push({ errorText: errorMessage });
});
client.on('Network.webSocketCreated', ({ requestId, url }, sessionId) => {
  if (url.includes(PROBE_MARK)) probeRequests.set(requestId, 'websocket');
  recordVenueTraffic(sessionId, url);
  // The host resolver rule fails the connection; the attempt is still evidence.
  if (isBlockedUrl(url, mainnetHosts)) {
    appendEntry({
      kind: 'blocked-mainnet',
      t: Date.now(),
      transport: 'websocket',
      url: shortUrl(url),
      probe: url.includes(PROBE_MARK),
    });
    say(`blocked a mainnet WebSocket to ${shortUrl(url)}`);
  }
});
for (const event of [
  'Page.domContentEventFired',
  'Page.loadEventFired',
  'Page.navigatedWithinDocument',
]) {
  client.on(event, (_params, sessionId) => {
    if (hudSessions.has(sessionId)) drawHud([sessionId]);
  });
}
// The file watch catches state changes; the slow repeat redraws a HUD that a
// client-side render removed.
watchFile(hudFile(runtimeDir), { interval: 500 }, () => drawHud());
const hudRepeat = setInterval(() => drawHud(), 2000);

client.on('close', () => {
  clearInterval(hudRepeat);
  unwatchFile(hudFile(runtimeDir));
  say('browser connection closed; exiting');
  process.exit(0);
});

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'about:' ? url : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '?';
  }
}

// Why the app tab never committed its first page (Codex #298 round 7: a
// 120 s stall seen once on mini): what Page.navigate answered, the tab's
// commits and document response, where the tab is now, and whether the dev
// server answers the same URL outside the browser.
async function commitStallDetail(navigation) {
  const info = await bounded(
    client.send('Target.getTargetInfo', { targetId: appTargetId }),
    'Target.getTargetInfo',
    5000,
  ).catch(() => null);
  const server = await fetch(startUrl, { signal: AbortSignal.timeout(5000), redirect: 'manual' })
    .then((response) => `HTTP ${response.status}`)
    .catch((error) => (error?.name === 'TimeoutError' ? 'no answer in 5 s' : 'unreachable'));
  return [
    `navigate answered ${navigation?.errorText ? `error ${navigation.errorText}` : `loader ${navigation?.loaderId ? 'set' : 'unset'}`}`,
    `commits [${appNavigation.commits.join(', ') || 'none'}]`,
    `document ${appNavigation.document ?? 'no response seen'}`,
    `tab now at ${pathOf(info?.targetInfo?.url ?? '')}`,
    `dev server ${server}`,
  ].join('; ');
}

function fail(message) {
  say(`not ready: ${message}`);
  process.exit(1);
}

await client.send('Target.setDiscoverTargets', { discover: true });
await client.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
});
const { targetInfos } = await client.send('Target.getTargets');
for (const info of targetInfos) {
  if (info.type === 'page') observeWalletSurface(info.targetId, info.url);
}
// The app gets a tab of its own, created blank: hooks and domains go in while
// nothing has loaded, then the tab navigates to the app.
// Created in the background so the browser is never activated (it would take
// the operator's keyboard focus on macOS). A visible browser started with no
// window gets the app in a new background window at the slot's bounds.
const windowBounds = String(args.window ?? '')
  .split(',')
  .map(Number);
const createParams =
  windowBounds.length === 4 && windowBounds.every(Number.isFinite)
    ? {
        url: 'about:blank',
        newWindow: true,
        background: true,
        left: windowBounds[0],
        top: windowBounds[1],
        width: windowBounds[2],
        height: windowBounds[3],
      }
    : { url: 'about:blank', newWindow: true, background: true };
const { targetId: appTargetId } = await bounded(
  // No foreground fallback: a tab that is not created in the background
  // activates the browser.
  client
    .send('Target.createTarget', createParams)
    .catch(() => client.send('Target.createTarget', { url: 'about:blank', background: true })),
  'Target.createTarget',
  60000,
);
const appStart = Date.now();
while (!hookedTargets.has(appTargetId) && Date.now() - appStart < 60000)
  await new Promise((resolve) => setTimeout(resolve, 50));
if (!hookedTargets.has(appTargetId)) fail(`app tab ${appTargetId} was never attached`);
const appSession = await bounded(
  hookedTargets.get(appTargetId).ready,
  'app tab hooks',
  60000,
).catch((error) => fail(error.message));
// Every other tab (the initial blank tab, app tabs restored with a reused
// profile, MetaMask's home tab) is closed, as the Extension launcher closes its
// startup tabs: the hooked tab is then the only app tab and the active tab of
// its window, so it paints without ever being brought to front.
const { targetInfos: startupTabs } = await client
  .send('Target.getTargets')
  .catch(() => ({ targetInfos }));
for (const info of startupTabs) {
  if (info.type === 'page' && info.targetId !== appTargetId && !isWalletSurfaceUrl(info.url)) {
    await client.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
  }
}
// The first app document is a market page: it streams from the venue in the
// browser, which the served-network check below observes (the home page's
// data comes from the server render).
const startUrl = new URL(args['start-path'] || policy.startPath, `${appOrigin}/`).href;
appNavigation.session = appSession;
const navigation = await bounded(
  client.send('Page.navigate', { url: startUrl }, appSession),
  'Page.navigate',
  60000,
).catch((error) => fail(error.message));
const navigateStart = Date.now();
// A cold dev server compiles the first page before it answers.
const commitTimeoutMs = Number(process.env.MM_HARNESS_APP_COMMIT_TIMEOUT_MS) || 120000;
while (
  !isExactAppUrl(sessionCommittedUrls.get(appSession), appOrigin) &&
  Date.now() - navigateStart < commitTimeoutMs
) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!isExactAppUrl(sessionCommittedUrls.get(appSession), appOrigin))
  fail(`the app tab did not commit ${startUrl}: ${await commitStallDetail(navigation)}`);

const evaluate = (expression, timeoutMs = 5000) =>
  bounded(
    client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      appSession,
    ),
    'app evaluation',
    timeoutMs,
  )
    .then((response) => response?.result?.value)
    .catch(() => undefined);

// The first app document must carry the log binding and the installed
// preload (its marker), with the page's provider wrapped, or requests on it
// would go unrecorded.
const readyExpression = pageReadyExpression({ signer, refusesTypedData: refuseTypedData !== null });
let hooksReady = false;
for (let attempt = 0; attempt < 50 && !hooksReady; attempt += 1) {
  hooksReady = (await evaluate(readyExpression)) === true;
  if (!hooksReady) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!hooksReady)
  fail('the app document has no wallet log binding, no harness preload, or an unwrapped provider');

if (network === 'testnet') {
  // The block must hold before anything runs: a probe to the mainnet venue
  // from the app page has to fail (HTTP through the request block and the
  // resolver rule, WebSocket through the resolver rule).
  const { probe } = policy;
  const host = mainnetHosts.includes(probe.host) ? probe.host : mainnetHosts[0];
  const httpProbe = await evaluate(
    `fetch('https://${host}${probe.httpPath}?${PROBE_MARK}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(probe.httpBody)} }).then(() => 'reached', () => 'blocked')`,
    20000,
  );
  const resolverProbe = await evaluate(
    `fetch('https://${host}:${RESOLVER_PROBE_PORT}${probe.httpPath}?${PROBE_MARK}', { method: 'POST' }).then(() => 'reached', () => 'blocked')`,
    20000,
  );
  const wsProbe = await evaluate(
    `new Promise((resolve) => { const socket = new WebSocket('wss://${host}${probe.wsPath}?${PROBE_MARK}'); const done = (value) => { try { socket.close(); } catch {} resolve(value); }; socket.onopen = () => done('reached'); socket.onerror = () => done('blocked'); setTimeout(() => done('timeout'), 10000); })`,
    20000,
  );
  if (httpProbe !== 'blocked' || resolverProbe !== 'blocked' || wsProbe !== 'blocked') {
    fail(
      `the mainnet venue is reachable from the app (http ${httpProbe}, resolver ${resolverProbe}, websocket ${wsProbe})`,
    );
  }
  const blockedHere = () =>
    probeFailedHere &&
    probeFailures.http.some((failure) =>
      /^net::ERR_BLOCKED_BY_CLIENT\b/u.test(failure.errorText ?? ''),
    );
  const unresolved = () =>
    probeFailures.resolver.some((failure) =>
      /^net::ERR_NAME_NOT_RESOLVED\b/u.test(failure.errorText ?? ''),
    );
  const probeStart = Date.now();
  while (!(blockedHere() && unresolved()) && Date.now() - probeStart < 5000)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const seen = (failures) =>
    failures
      .map((failure) => [failure.errorText, failure.blockedReason].filter(Boolean).join(' '))
      .join('; ') || 'no failure reported';
  if (!blockedHere())
    fail(
      `the HTTP probe failed, but not by the request block (${seen(probeFailures.http)}; failed here: ${probeFailedHere})`,
    );
  if (!unresolved())
    fail(
      `the resolver probe failed, but not by the host resolver rule (${seen(probeFailures.resolver)})`,
    );
  // The app must actually be talking to the testnet venue.
  const servedStart = Date.now();
  let traffic = venueTraffic.get(appSession);
  const servedTimeoutMs = Number(process.env.MM_HARNESS_SERVED_TIMEOUT_MS) || 90000;
  while (
    servedApplicable &&
    (!traffic || (traffic.testnet.size === 0 && traffic.mainnet.size === 0)) &&
    Date.now() - servedStart < servedTimeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    traffic = venueTraffic.get(appSession);
  }
  if (traffic?.mainnet.size)
    fail(
      `the app requested the mainnet venue (${[...traffic.mainnet].join(', ')}): the dev server does not serve testnet`,
    );
  if (servedApplicable && !traffic?.testnet.size)
    fail(
      `the app made no request to a testnet venue endpoint (${testnetHosts.join(', ') || 'none known'}) within ${Math.round(servedTimeoutMs / 1000)}s, so its network could not be checked`,
    );
  appendEntry({
    kind: 'network-enforcement',
    t: Date.now(),
    network,
    enforcement: 'enforced',
    mainnetHosts,
    servedHosts: [...(traffic?.testnet ?? [])],
    ...(servedApplicable ? {} : { served: 'not-applicable' }),
    probes: {
      http: seen(probeFailures.http),
      resolver: seen(probeFailures.resolver),
      websocket: seen(probeFailures.websocket),
    },
  });
} else {
  appendEntry({
    kind: 'network-enforcement',
    t: Date.now(),
    network,
    enforcement: 'disabled',
    reason: 'network=mainnet with mainnet_confirmation=REAL_FUNDS',
  });
}
say(`opened app tab ${appTargetId}`);
writeFileSync(
  path.join(runtimeDir, 'wallet-host.ready'),
  `${JSON.stringify({ pid: process.pid, signer, network, at: new Date().toISOString() })}\n`,
);
say(`ready (signer=${signer}, network=${network}, app=${appOrigin})`);
