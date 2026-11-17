// Real sign-in/reload proof. Never reads browser storage or exports credentials.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { CdpSession } from '../../../packages/recipe-runner/src/runtime/cdp.ts';

const action = process.argv[2];
const port = Number(process.env.FARMSLOT_CDP_PORT);
const output = process.env.FARMSLOT_LOGIN_PROOF_OUTPUT;
const pageUrl = process.env.FARMSLOT_LOGIN_PROOF_URL;
assert(port && output && pageUrl, 'Select owned Agent Chrome, output and login page');
await mkdir(output, { recursive: true });
const metadataPath = path.join(output, 'owned-browser.json');
const execute = promisify(execFile);
const cdpHelper = new URL('./cdp.mjs', import.meta.url).pathname;
const browserInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await CdpSession.connect(browserInfo.webSocketDebuggerUrl);
let page;
try {
  if (action === 'create') {
    const { browserContextId } = await browser.call('Target.createBrowserContext');
    const { targetId } = await browser.call('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    await writeFile(metadataPath, JSON.stringify({ browserContextId, targetId }, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(JSON.stringify({ created: true, targetId }));
    process.exitCode = 0;
  } else {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (action === 'close') {
      await browser.call('Target.disposeBrowserContext', {
        browserContextId: metadata.browserContextId,
      });
      console.log(JSON.stringify({ closedOwnedContext: true }));
    } else {
      const { targetInfo } = await browser.call('Target.getTargetInfo', {
        targetId: metadata.targetId,
      });
      assert.equal(targetInfo.browserContextId, metadata.browserContextId);
      page = await CdpSession.connect(`ws://127.0.0.1:${port}/devtools/page/${metadata.targetId}`);
      await page.call('Page.enable');
      await page.call('Page.bringToFront');
      if (action === 'signin') {
        let stdout;
        try {
          ({ stdout } = await execute(
            'yarn',
            [
              '--cwd',
              'apps/command-center',
              'farmslot',
              '--gateway',
              process.env.FARMSLOT_GATEWAY_PROFILE,
              '--json',
              'pair',
              '--principal',
              process.env.FARMSLOT_LOGIN_PROOF_PRINCIPAL,
            ],
            { timeout: 30000, maxBuffer: 1024 * 1024 },
          ));
        } catch (error) {
          // Pairing output may contain a one-use credential. Retain privately, never echo it.
          await writeFile(
            path.join(output, 'private-pairing-failure.log'),
            String(error.stderr ?? '') + String(error.stdout ?? ''),
            { mode: 0o600 },
          );
          throw new Error('QA pairing failed; credential-bearing diagnostics are private');
        }
        let grant;
        try {
          grant = JSON.parse(stdout);
        } catch {
          throw new Error('The credential-bearing pairing response was not valid JSON');
        }
        const code = grant.data?.payload?.profiles?.[0]?.code;
        assert(typeof code === 'string' && code.length > 0, 'A one-use pairing code is required');
        // Code only deliberately keeps the implicit endpoint, as a token sign-in did before #2259.
        const link = new URL(pageUrl);
        const hash = link.hash.slice(1);
        const split = hash.indexOf('?');
        const route = split < 0 ? hash : hash.slice(0, split);
        const params = new URLSearchParams(split < 0 ? '' : hash.slice(split + 1));
        params.set('connect', Buffer.from(JSON.stringify({ v: 1, code })).toString('base64url'));
        link.hash = route + '?' + params.toString();
        await page.call('Page.navigate', { url: link.href });
      } else if (action === 'clean') {
        await page.call('Page.navigate', { url: pageUrl });
        await execute(process.execPath, [cdpHelper, 'reload', '@' + metadata.targetId], {
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        });
      } else if (action === 'refresh') {
        await execute(process.execPath, [cdpHelper, 'reload', '@' + metadata.targetId], {
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        });
      } else if (action !== 'inspect') throw new Error('Unknown proof action');
      let state;
      const end = Date.now() + 45000;
      do {
        const result = await page.call(
          'Runtime.evaluate',
          {
            expression: `(() => {
          const app = document.querySelector('farm-app');
          return {connection: app?.connection, principalId: app?.devicesPrincipalId ?? null,
            authRequired: Boolean(document.querySelector('.auth-card')),
            origin: location.origin, documentTimeOrigin: performance.timeOrigin, documentState: document.readyState,
            gatewayUrl: document.querySelector('fleet-summary-bar')?.gatewayUrl};
        })()`,
            returnByValue: true,
          },
          { timeoutMs: 10000 },
        );
        assert(!result.exceptionDetails, 'The public UI state probe must run');
        state = result.result.value;
        if (state.connection === 'connected' || state.authRequired) break;
        await delay(100);
      } while (Date.now() < end);
      const label = process.env.FARMSLOT_LOGIN_PROOF_LABEL ?? action;
      await writeFile(path.join(output, label + '.json'), JSON.stringify(state, null, 2) + '\n');
      const screenshot = await page.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(output, label + '.png'), Buffer.from(screenshot.data, 'base64'));
      const expected = process.env.FARMSLOT_LOGIN_PROOF_EXPECT;
      if (expected === 'connected') {
        assert.equal(
          state.connection,
          'connected',
          'Saved login must reconnect without another sign-in',
        );
        assert.equal(state.authRequired, false);
        if (process.env.FARMSLOT_LOGIN_PROOF_PRINCIPAL)
          assert.equal(state.principalId, process.env.FARMSLOT_LOGIN_PROOF_PRINCIPAL);
      } else if (expected === 'auth_required') {
        assert.equal(
          state.authRequired,
          true,
          'The unchanged legacy default must reproduce the sign-in prompt',
        );
      }
      assert.equal(state.origin, new URL(pageUrl).origin);
      console.log(JSON.stringify(state));
    }
  }
} finally {
  page?.close();
  browser.close();
}
