// Compiles the call shapes real hosts use (mm-harness, Command Center) against the
// emitted declarations, so a wrong JSDoc type fails `yarn typecheck`.
import browserCdp = require('@farmslot/adapter-web/browser-cdp');
import browserResolver = require('@farmslot/adapter-web/browser-resolver');
import chromeArgs = require('@farmslot/adapter-web/chrome-args');
import dapp = require('@farmslot/adapter-web/dapp');
import extensionId = require('@farmslot/adapter-web/extension-id');
import launch = require('@farmslot/adapter-web/launch-browser');
import macosFocus = require('@farmslot/adapter-web/macos-focus');
import networkObserver = require('@farmslot/adapter-web/network-observer');
import origin = require('@farmslot/adapter-web/origin');
import pageTarget = require('@farmslot/adapter-web/page-target');
import performanceObserver = require('@farmslot/adapter-web/performance-observer');
import playwrightCdp = require('@farmslot/adapter-web/playwright-cdp');
import slotTitle = require('@farmslot/adapter-web/slot-title');
import ownership = require('@farmslot/adapter-web/validation-process-ownership');

export async function consumerCalls(
  page: unknown,
  profile: string,
  dist: string,
  runtimeDir: string,
) {
  const client = await browserCdp.connectBrowserCdp(9222, { timeoutMs: 5000 });
  await browserCdp.placeWindow(client.send, 'T1', {
    left: 200,
    top: 150,
    width: 1200,
    height: 800,
  });
  await browserCdp.openBackgroundWindow(client.send, 'about:blank', 15000);
  const offEvent: () => void = client.onEvent((event) => {
    const method: string = event.method;
    const sessionId: string | undefined = event.sessionId;
    browserCdp.asBrowserCdpTarget(event.params.targetInfo)?.targetId.trim();
    return { method, sessionId };
  });
  offEvent();
  client.onClose(() => undefined);
  const { targetInfos } = await client.send('Target.getTargets', {});
  const extension: string | null = browserCdp.extensionIdFromCdpTargets(targetInfos);
  const ui = pageTarget.selectExtensionTarget(targetInfos, extension ?? 'abc', {
    paths: ['/home.html', '/sidepanel.html'],
  });
  ui?.targetId.trim();
  client.close();
  const pids: number[] = browserCdp.cdpListenerPids(9222);
  const owner = browserCdp.cdpOwner(9222, profile);
  const waited = browserCdp.waitForCdpOwner(9222, profile, { timeoutMs: 15000 });
  browserCdp.assertCdpOwnedByProfile(9222, profile, { timeoutMs: 15000 });
  const loaded = await browserCdp.loadUnpackedOverPort(9222, dist, { profile });
  await browserCdp.loadUnpackedOverPort(9222, dist, {
    profile,
    expectedId: 'abc',
    url: 'chrome-extension://abc/home.html',
    timeoutMs: 60000,
  });
  const resolution = await browserResolver.resolveBrowser({
    cft: () => ({ executable: '/Applications/Chrome.app/Contents/MacOS/Chrome' }),
    launchMethod: browserResolver.LAUNCH_SERVICES,
    display: browserResolver.HEADFUL,
    recorded: null,
  });
  const launchArgs: string[] = browserResolver.extensionLaunchArgs(
    dist,
    resolution.extensionLoading,
  );
  browserResolver.waitForCdpOwner(9222, profile, { timeoutMs: 15000 });
  chromeArgs.writeRuntimeIdentity(runtimeDir, {
    nonce: chromeArgs.createRuntimeIdentityNonce(),
    cdpPort: 9222,
    pid: 123,
    profile,
  });
  ownership.stopProfileProcessesSync(profile, { waitForAppearanceMs: 400 });
  ownership.stopProfileProcessesSync(profile, { extraPids: [123] });
  await ownership.stopProfileProcesses(profile, { quietMs: 500, timeoutMs: 5000 });
  const ownedPids: number[] = ownership.profileProcessPids(profile);
  const front = macosFocus.captureMacFrontmost();
  macosFocus.restoreFrontmostIfOurs(front, [123]);
  macosFocus.macBackgroundOpenArgs('/Applications/Chrome.app', ['--flag']);
  macosFocus.activateMacAppByPid(123);
  const selected = pageTarget.selectPageTarget([{ id: 'x', type: 'page', url: 'http://a/' }], {
    origin: 'http://a',
    hash: '#prs',
  });
  await playwrightCdp.evaluatePageViaCdp(page, () => document.title);
  await playwrightCdp.evaluatePageViaCdp(page, (slot: string) => slot, 'ff-1');
  extensionId.extensionIdFromExtensionDir(dist);
  const launched = launch.launchBrowser({
    cdpPort: 9222,
    chromeBin: '/Applications/Chrome.app/Contents/MacOS/Chrome',
    profile,
    extensionDir: dist,
    runtimeDir,
    chromeLog: `${runtimeDir}/chrome.log`,
    chromePid: `${runtimeDir}/chrome.pid`,
    browserResolution: `${runtimeDir}/browser-resolution.json`,
    homePage: 'home.html',
    defaultTitle: 'Product',
    extensionOwnerRoot: (dir: string) => (dir.startsWith(runtimeDir) ? runtimeDir : null),
    acquireRuntimeLock: () => () => undefined,
    rerunCommand: 'host launch',
    focusSettleMs: 0,
  });
  if (!launched.stopped) launched.pid.toFixed();
  launch.launchBrowser({
    cdpPort: 9222,
    chromeBin: '',
    profile,
    extensionDir: dist,
    runtimeDir,
    chromeLog: '',
    chromePid: '',
    stopOnly: true,
    resetProfile: true,
  });
  const slotId: string = slotTitle.readSlotId(runtimeDir, 'temp/recipe/runtime');
  slotTitle.buildStampExpression(slotTitle.sanitizeSlotId(slotId), 'Product');
  await playwrightCdp.evaluatePageViaCdp(page, slotTitle.applyPersistentSlotTitle, {
    slotId,
    defaultTitle: 'Product',
  });
  const stamp = await slotTitle.stampHomeTabsViaCdp({
    cdpPort: 9222,
    extensionId: 'abc',
    homePage: 'home.html',
    defaultTitle: 'Product',
    target: runtimeDir,
    runtimeDir: 'temp/recipe/runtime',
  });
  stamp.stamped.toFixed();
  return { pids, owner, waited, loaded, selected, ownedPids, launchArgs };
}

// The MetaMask harness's Extension network and performance observers.
export async function observerCalls(runtimeDir: string) {
  const network = await networkObserver.createExtensionNetworkObserver({
    cdpPort: 9222,
    runtimeDir,
  });
  await networkObserver.createExtensionNetworkObserver({
    cdpPort: 9222,
    runtimeDir,
    connectTimeoutMs: 10000,
    commandTimeoutMs: 10000,
  });
  await network.start({ id: 'n1', urlIncludes: ['api'] });
  const summary: Record<string, unknown> = await network.end('n1');
  await network.close();
  const performance = await performanceObserver.createExtensionPerformanceBackend({
    cdpPort: 9222,
    extensionId: 'abc',
    uiPaths: ['/home.html', '/sidepanel.html'],
    kind: {
      categories: ['blink.user_timing'],
      rendererScoped: true,
      scope: 'extension-renderer',
      nativeSource: 'chromium-cdp-frame-timings',
      javascriptTasks: true,
      frameTiming: 'draw',
    },
    platform: 'extension',
    markerPrefix: 'mmh-clock-',
    connectTimeoutMs: 10000,
    commandTimeoutMs: 10000,
  });
  await performance.start('p1');
  const result = await performance.end('p1');
  const platform: 'extension' = result.platform;
  const scope: string = result.trace.scope;
  const frames: number = result.nativeUi.summary.frameCount;
  await performance.close();
  return { summary, platform, scope, frames };
}

// The MetaMask harness's Web Terminal wallet host and its wallet actions.
export async function dappCalls(
  client: {
    send(method: string, params?: object, sessionId?: string): Promise<unknown>;
    on(method: string, handler: (params: any, sessionId?: string) => void): () => void;
  },
  account: {
    address: string;
    signTypedData(args: unknown): Promise<string>;
    signMessage(args: unknown): Promise<string>;
  },
  logFile: string,
) {
  const refuseTypedData = {
    reason: (data: { message?: { env?: string } }) =>
      data?.message?.env === 'production' ? 'env=production' : null,
    kind: 'refused-production',
    message: 'Refused.',
  };
  const source: string = dapp.pageScriptSource({
    signer: 'injected',
    appOrigin: 'http://localhost:3000',
    refuseTypedData,
    injectedWallet: {
      info: { uuid: 'u', name: 'Test', icon: 'data:,', rdns: 'test.wallet' },
      isMetaMask: true,
    },
  });
  dapp.pageScriptSource({ signer: 'extension', appOrigin: 'http://localhost:3000' });
  const ready: string = dapp.pageReadyExpression({ signer: 'injected', refusesTypedData: true });
  const wallet = dapp.createStrictWallet({ account, chainId: 42161 });
  const binding = dapp.createWalletRequestBinding({
    client,
    appOrigin: 'http://localhost:3000',
    signer: 'injected',
    wallet,
    refuseTypedData,
    record: () => {},
    say: () => {},
  });
  await binding.install('S1', 'T1');
  binding.commit('S1', 'http://localhost:3000/', 'L1');
  binding.drain('S1');
  binding.detach('S1');
  const log = { logFile, cursorFile: `${logFile}.cursor` };
  const policy = {
    typedDataClasses: {
      sessionRequests: {
        match: () => false,
        param: 'max_session_requests',
        defaultMax: 0,
        failure: (count: number, max: number) => `${count} > ${max}`,
      },
    },
    forbiddenEntries: {
      blocked: {
        match: (entry: { kind?: string }) => entry.kind === 'blocked',
        failure: (count: number) => `${count}`,
      },
    },
  };
  const { window, result } = await dapp.awaitSignatureLog(log, { timeout_ms: 0 }, policy);
  const summary = dapp.summarize(window.entries, policy);
  const permits: number = summary.byPrimaryType.Permit?.signed ?? 0;
  const accounts: number = summary.byMethod.eth_requestAccounts ?? 0;
  const sessions: number = summary.sessionRequests;
  const chainId: unknown = await wallet.request({ method: 'eth_chainId' });
  await wallet.request({ method: 'eth_getBalance', params: [account.address, 'latest'] });
  const reset = await dapp.resetWindow(log);
  const artifacts = await dapp.writeLogArtifact(
    { artifactsDir: '/tmp', nodeId: 'n', folder: 'wallet' },
    { summary },
  );
  const sameOrigin: boolean = origin.isAppUrl('http://localhost:3000/x', 'http://localhost:3000');
  const top: boolean = origin.isAppTopFrameContext(
    { origin: 'http://localhost:3000', auxData: { isDefault: true, frameId: 'T1' } },
    { targetId: 'T1', appOrigin: 'http://localhost:3000', committedUrl: 'http://localhost:3000/' },
  );
  return {
    permits,
    accounts,
    sessions,
    chainId,
    source,
    ready,
    ok: result.ok,
    reset: reset.cursor,
    path: artifacts[0]?.path,
    sameOrigin,
    top,
    short: origin.shortUrl('x'),
  };
}
