// Native copy-link proof against a disposable desktop profile and an existing gateway.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { confirmDesktopQuit } from './lib/desktop-quit.mjs';

const app = path.resolve(
  process.env.FARMSLOT_DESKTOP_TEST_APP ??
    'temp/desktop-validation/mac-arm64/Farmslot Validation.app',
);
assert.equal(
  execFileSync(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')],
    { encoding: 'utf8' },
  ).trim(),
  'io.farmslot.command-center.validation',
  'Never use the installed app bundle identity for this validation',
);
const port = process.env.FARMSLOT_CDP_PORT ?? '9527';
const gateway = process.env.FARMSLOT_GATEWAY;
const ui = process.env.FARMSLOT_UI_URL;
const runId = process.env.FARMSLOT_TEST_RUN_ID;
assert.ok(gateway && ui && runId, 'Set the validation gateway, UI URL and real run ID');
const profile = await mkdtemp(path.join(os.tmpdir(), 'desktop-run-view-links-'));
await writeFile(
  path.join(profile, 'preferences.json'),
  JSON.stringify({
    shortcut: '',
    route: '#runs',
    development: { enabled: true, url: ui },
  }),
);
const env = { ...process.env, FARMSLOT_CDP_PORT: port };
function cdp(...args) {
  return execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: 'pipe',
  }).trim();
}
const value = (expression) => JSON.parse(cdp('eval', '-', `return {value:(${expression})};`)).value;
async function waitFor(check) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error('Desktop check timed out');
}
assert.equal(JSON.parse(cdp('gateway', 'run.get', JSON.stringify({ runId }))).run.id, runId);
const child = spawn(path.join(app, 'Contents/MacOS/Farmslot Validation'), [], {
  env: { ...env, FARMSLOT_DESKTOP_USER_DATA: profile, FARMSLOT_DESKTOP_CDP_PORT: port },
  stdio: 'ignore',
});
const exited = once(child, 'exit');
try {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch((error) => {
      if (['ECONNREFUSED', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code)) return null;
      throw error;
    });
    return response && (await response.json()).some((t) => t.type === 'page');
  });
  await waitFor(() =>
    value(
      'Boolean(document.querySelector("#gateway-url")?.getClientRects().length && !document.querySelector("#gateway-url").disabled)',
    ),
  );
  cdp('fill', '-', '#gateway-url', gateway);
  cdp('select', '-', '#auth-mode', 'none');
  cdp('click', '-', '#connection-form button');
  await waitFor(() => value('document.querySelector("farm-app")?.connection === "connected"'));
  await waitFor(() => value('document.querySelector("farm-app")?.hydrated === true'));
  cdp('click', '-', 'button.primary');
  for (const route of [
    `#run/${runId}?step=monitor`,
    `#runs?run=${runId}&step=monitor`,
    `#run/${runId}?artifactRun=${runId}&artifact=artifacts%2Freport.md`,
    `#run/${runId}?artifactRun=${runId}&artifact=artifacts%2Fvideos%2Frecipe-run.mp4&artifactTrace=7&artifactPhase=end`,
  ]) {
    // Normal URL navigation, followed by the real button and desktop IPC.
    cdp('eval', '-', `location.hash=${JSON.stringify(route)};return true;`);
    await waitFor(() => value('location.hash') === route);
    if (route.includes('artifact=') || route.startsWith('#runs?')) {
      // Closing the overlay erases the selected artifact; exercise the button's
      // actual native IPC endpoint while that selection remains open.
      const copied = JSON.parse(
        cdp('eval', '-', 'return {link:await window.farmslotDesktop.copyCurrentLink()};'),
      ).link;
      assert.equal(copied, `farmslot-validation://view/${route}`);
    } else {
      cdp('screenshot', '-', '/tmp/desktop-run-copy-before.png');
      cdp('click', '-', 'button.copy-link');
      await waitFor(
        () =>
          execFileSync('pbpaste', { encoding: 'utf8' }) === `farmslot-validation://view/${route}`,
      );
    }
    assert.equal(
      execFileSync('pbpaste', { encoding: 'utf8' }),
      `farmslot-validation://view/${route}`,
    );
    // Reopen through the macOS URL event, using the isolated validation bundle.
    cdp('eval', '-', 'location.hash="#fleet";return true;');
    execFileSync('open', ['-a', app, `farmslot-validation://view/${route}`]);
    await waitFor(() => value('location.hash') === route);
    execFileSync('pbcopy', { input: 'desktop-navigation-test', encoding: 'utf8' });
    execFileSync(
      'osascript',
      [
        '-e',
        `tell application "System Events" to tell (first process whose unix id is ${child.pid})
      set frontmost to true
      repeat 50 times
        if exists menu bar item "Farmslot Validation" of menu bar 1 then exit repeat
        delay 0.1
      end repeat
      click menu item "Copy Link to Current View" of menu 1 of menu bar item "Farmslot Validation" of menu bar 1
    end tell`,
      ],
      { timeout: 10000, stdio: 'pipe' },
    );
    await waitFor(
      () => execFileSync('pbpaste', { encoding: 'utf8' }) === `farmslot-validation://view/${route}`,
    );
    const preferences = JSON.parse(
      cdp('eval', '-', 'return {route:(await window.farmslotDesktop.loadPreferences()).route};'),
    );
    assert.equal(preferences.route, route);
  }
  cdp(
    'eval',
    '-',
    `location.hash=${JSON.stringify(`#runs?run=${runId}&step=monitor&token=fixture-marker`)};return true;`,
  );
  const rejected = JSON.parse(
    cdp(
      'eval',
      '-',
      'return {rejected:await window.farmslotDesktop.copyCurrentLink().then(()=>false,()=>true)};',
    ),
  ).rejected;
  assert.equal(rejected, true, 'Credential parameters must still be rejected');
  if (process.env.FARMSLOT_TEST_HTML_REPORT) {
    const htmlRoute = `run/${runId}?artifactRun=${runId}&artifact=${encodeURIComponent(process.env.FARMSLOT_TEST_HTML_REPORT)}`;
    cdp('eval', '-', `location.hash=${JSON.stringify('#' + htmlRoute)};return true;`);
    execFileSync(process.execPath, ['scripts/e2e-html-report.mjs'], {
      env: { ...env, FARMSLOT_UI_URL: ui, FARMSLOT_HTML_REPORT_ROUTE: htmlRoute },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    });
  }
  console.log(
    JSON.stringify({
      pass: true,
      stepLinkCopied: true,
      reportLinkCopied: true,
      nativeMenuCopied: true,
      macOSLinksReopened: true,
      savedNavigationMatches: true,
      credentialsRejected: true,
      htmlReportVerified: Boolean(process.env.FARMSLOT_TEST_HTML_REPORT),
    }),
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    execFileSync(
      'osascript',
      [
        '-e',
        `tell application \"System Events\" to tell (first process whose unix id is ${child.pid})
      set frontmost to true
      keystroke \"q\" using command down
    end tell`,
      ],
      { timeout: 10000, stdio: 'pipe' },
    );
    confirmDesktopQuit(child.pid);
  }
  await exited;
}
