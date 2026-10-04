// Compiles the call shapes real hosts use (mm-harness, Command Center) against the
// emitted declarations, so a wrong JSDoc type fails `yarn typecheck`.
import browserCdp = require('@farmslot/adapter-web/browser-cdp');
import browserResolver = require('@farmslot/adapter-web/browser-resolver');
import chromeArgs = require('@farmslot/adapter-web/chrome-args');
import extensionId = require('@farmslot/adapter-web/extension-id');
import launch = require('@farmslot/adapter-web/launch-browser');
import macosFocus = require('@farmslot/adapter-web/macos-focus');
import pageTarget = require('@farmslot/adapter-web/page-target');
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
