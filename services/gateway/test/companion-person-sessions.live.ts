// Manual cross-client contract proof. Uses only isolated fixture identities.
import assert from 'node:assert/strict';
import test from 'node:test';

import { testGatewayConnection as testCompanionGatewayConnection } from '../../../apps/companion/src/lib/gateway-connection-test.js';
import { exchangeGatewayPairingQr } from '../../../apps/companion/src/lib/gateway-pairing-exchange.js';
import {
  hasAuthErrorCode,
  Methods,
  type PairingCreateResult,
  type PersonSessionAuth,
  type PersonSessionGrant,
} from '../../../packages/protocol/src/index.js';
import { rpcFixture } from '../src/security/person-sessions.test.js';

test('the Companion transport exchanges, renews and clears person authority through the public gateway', async (t) => {
  const f = await rpcFixture(t);
  let saved: PersonSessionAuth | null = null;
  const sessionStorage = {
    load: async () => saved,
    save: async (value: PersonSessionAuth | null) => {
      saved = value;
    },
  };
  const first = await testCompanionGatewayConnection(f.url, {
    token: f.credential.secret,
    explicitPersonSignIn: true,
    sessionStorage,
  });
  assert.equal(first.principal?.id, f.person.id);
  assert.equal(first.gatewayPingSupported, false);
  const administrator = await testCompanionGatewayConnection(f.url, {
    token: f.adminCredential.secret,
  });
  assert.equal(administrator.gatewayPingSupported, true);
  assert.ok(saved);
  const snapshot = await sessionStorage.load();
  assert.ok(snapshot);
  assert.ok(!JSON.stringify(snapshot).includes('fsa_'));
  assert.ok(!JSON.stringify(snapshot).includes(f.credential.secret));
  const second = await testCompanionGatewayConnection(f.url, {
    sessionStorage,
    personSessionRequired: true,
  });
  assert.equal(second.principal?.id, f.person.id);
  const access = await f.client().call<PersonSessionGrant>(Methods.AUTH_SESSION_REFRESH, {
    refreshToken: snapshot.refreshToken,
  });
  await f
    .client(access.accessToken)
    .call(Methods.AUTH_SESSION_REVOKE, { sessionId: access.session.id });
  await assert.rejects(
    testCompanionGatewayConnection(f.url, { sessionStorage, personSessionRequired: true }),
    (error: unknown) => hasAuthErrorCode(error, 'AUTH_SESSION_ENDED'),
  );
  assert.equal(await sessionStorage.load(), null);
});

test('Companion person pairing exchanges one invitation across its declared profile aliases', async (t) => {
  const f = await rpcFixture(t);
  const pairing = await f
    .client(f.adminCredential.secret)
    .call<PairingCreateResult>(Methods.PAIRING_CREATE, {
      gatewayUrl: f.url,
      authority: { kind: 'existing-principal', principalId: f.person.id },
    });
  const profiles = await exchangeGatewayPairingQr({
    type: 'farmslot.gateway-pairing.v1',
    profiles: [
      { url: f.url, code: pairing.code, profileName: 'Primary' },
      { url: f.url.replace('127.0.0.1', 'localhost'), code: pairing.code, profileName: 'Alias' },
    ],
  });
  assert.equal(profiles.length, 2);
  assert.ok(profiles[0].personSession);
  assert.equal(profiles[0].personSession.refreshToken, profiles[1].personSession?.refreshToken);
  assert.equal(profiles[0].secret, undefined);
  assert.equal(profiles[0].verification?.principal?.id, f.person.id);
  assert.equal(profiles[1].verification?.principal?.id, f.person.id);
  assert.ok(!JSON.stringify(profiles).includes('fsa_'));
  assert.equal(f.authRuntime.store.snapshot().personSessions.length, 1);
  await assert.rejects(
    f.client().call(Methods.AUTH_SESSION_EXCHANGE, { code: pairing.code, ...f.device }),
    (error: unknown) => hasAuthErrorCode(error, 'PAIRING_FAILED'),
  );
});

test('Command Center restores one device, renews HTTP access and revokes through public RPCs', async (t) => {
  const f = await rpcFixture(t, true);
  const store = new Map<string, string>();
  const cookies: string[] = [];
  const location = {
    protocol: 'http:',
    host: new URL(f.url).host,
    hash: '',
    origin: f.http,
    hostname: '127.0.0.1',
    href: f.http + '/',
    pathname: '/',
  };
  const globals = {
    window: { location },
    location,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    document: {
      set cookie(value: string) {
        cookies.push(value);
      },
    },
  };
  const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const { GatewayClient, gateway } =
    await import('../../../apps/command-center/ui/src/gateway-client.js');
  const { gatewayApiUrl, gatewayHttpFetch } =
    await import('../../../apps/command-center/ui/src/utils/gateway-origin.js');
  const clients: InstanceType<typeof GatewayClient>[] = [gateway];
  t.after(() => clients.forEach((client) => client.disconnect()));
  const connect = async (client: InstanceType<typeof GatewayClient>) => {
    const ready = new Promise<void>((resolve, reject) => {
      const off = client.onConnectionChange((state) => {
        if (state === 'connected' || state === 'auth_required') {
          off();
          state === 'connected'
            ? resolve()
            : reject(client.authError ?? new Error('Sign-in required'));
        }
      });
    });
    client.connect();
    await ready;
  };
  let browser = new GatewayClient(f.url);
  clients.push(browser);
  await browser.setAuthCredentials({ token: f.credential.secret });
  await connect(browser);
  const sessionId = browser.personSession?.id;
  assert.ok(sessionId);
  assert.equal((await browser.signedInDevices()).length, 1);
  const bytes = JSON.stringify([...store.values()]);
  assert.ok(bytes.includes('fsr_'));
  assert.ok(!bytes.includes('fsa_'));
  assert.ok(!bytes.includes(f.credential.secret));
  assert.ok(
    cookies.every((cookie) => !cookie.includes('fsa_') && !cookie.includes(f.credential.secret)),
  );
  assert.equal(new URL(gatewayApiUrl('/api/run-artifact')).searchParams.has('token'), false);
  assert.equal(
    await (await gatewayHttpFetch('/api/run-artifact', undefined, null)).text(),
    'authorized',
  );
  browser.disconnect();
  browser = new GatewayClient(f.url);
  clients.push(browser);
  await connect(browser);
  assert.equal(browser.personSession?.id, sessionId);
  f.clock.now += 3_600_000;
  assert.equal(
    await (await gatewayHttpFetch('/api/run-artifact', undefined, null)).text(),
    'authorized',
  );
  await browser.signOut();
  assert.equal(browser.connectionState, 'auth_required');
  assert.equal(f.authRuntime.store.snapshot().personSessions[0].revokedAt !== null, true);
  assert.ok(!JSON.stringify([...store.values()]).includes('fsr_'));
});

test(
  'CDP person-session settings sign-in, device list, reconnect and confirmed sign-out',
  {
    skip: !process.env.FARMSLOT_PERSON_SESSIONS_UI_PROOF_DIR,
  },
  async (t) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { createServer } = await import('vite');
    const execute = promisify(execFile);
    const f = await rpcFixture(t, true, {
      '/api/person-session-proof.png': {
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=',
          'base64',
        ),
      },
      '/api/person-session-proof.md': {
        contentType: 'text/markdown',
        body: '# Session media proof\n\n![Proof](proof.png)',
      },
    });
    const output = process.env.FARMSLOT_PERSON_SESSIONS_UI_PROOF_DIR!;
    await mkdir(output, { recursive: true });
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const vite = await createServer({
      root: root + 'apps/command-center/ui',
      configFile: root + 'apps/command-center/ui/vite.config.ts',
      envFile: false,
      plugins: [
        {
          name: 'person-session-media-proof',
          transformIndexHtml: () => [
            {
              tag: 'script',
              attrs: { type: 'module' },
              children: `
          import { openMediaLightbox } from '/src/components/shared/media-lightbox.ts';
          const button = document.createElement('button');
          button.id = 'session-media-proof'; button.textContent = 'Open fixture report';
          button.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:10000';
          button.addEventListener('click', () => openMediaLightbox([
            { path: 'proof.md', purpose: 'Session report', url: '/api/person-session-proof.md' },
            { path: 'proof.png', purpose: 'Session image', url: '/api/person-session-proof.png' },
          ]));
          document.body.append(button);
        `,
            },
          ],
        },
      ],
      define: { 'import.meta.env.VITE_FARMSLOT_GATEWAY_URL': JSON.stringify(f.url) },
      server: {
        port: 0,
        strictPort: false,
        host: '127.0.0.1',
        proxy: {
          '/api': { target: f.http },
          '/ws': { target: f.url, ws: true },
        },
      },
    });
    t.after(() => vite.close());
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    const env = {
      ...process.env,
      FARMSLOT_CDP_PORT: process.env.FARMSLOT_CDP_PORT ?? '19223',
      FARMSLOT_UI_URL: `http://127.0.0.1:${address.port}`,
    };
    const cdp = async (...args: string[]) => {
      try {
        const result = await execute(
          process.execPath,
          [root + 'apps/command-center/scripts/cdp.mjs', ...args],
          { env, timeout: 45_000 },
        );
        return result.stdout.trim();
      } catch (error) {
        // Never include input argv or fixture credentials in a subprocess error.
        throw new Error(`Browser proof command ${args[0]} failed.`, {
          cause: error instanceof Error ? error.name : 'unknown',
        });
      }
    };
    const route = 'fleet';
    await cdp('goto', route, '--new');
    let tabOpen = true;
    t.after(async () => {
      if (tabOpen) await cdp('close', route);
    });
    const waitFor = async (expression: string) => {
      const result = await cdp(
        'eval',
        route,
        `const deadline=Date.now()+15000; while(!(${expression}) && Date.now()<deadline) await new Promise(r=>setTimeout(r,50)); return Boolean(${expression});`,
      );
      if (result !== 'true') {
        await cdp('screenshot', route, output + '/failure.png');
        await writeFile(
          output + '/failure.txt',
          await cdp(
            'eval',
            route,
            "return document.querySelector('.fa-account-options')?.innerText ?? document.body.innerText.slice(0,1000);",
          ),
        );
      }
      assert.equal(result, 'true');
    };
    await waitFor("document.querySelector('.auth-input')");
    await cdp('fill', route, '.auth-input', f.credential.secret);
    await cdp('click', route, '.auth-submit');
    await waitFor(
      "document.querySelector('[data-testid=account-menu]') && !document.querySelector('.auth-card')",
    );
    await cdp('click', route, '[data-testid=account-menu]');
    await cdp('click', route, '[data-testid=signed-in-devices]');
    await waitFor("document.querySelector('[data-testid=signed-in-device]')");
    await cdp('screenshot', route, output + '/signed-in-devices.png');
    assert.equal(f.authRuntime.store.snapshot().personSessions.length, 1);
    const id = f.authRuntime.store.snapshot().personSessions[0].id;
    await cdp('eval', route, 'location.reload(); return true;');
    await waitFor(
      "document.querySelector('[data-testid=account-menu]') && !document.querySelector('.auth-card')",
    );
    assert.equal(f.authRuntime.store.snapshot().personSessions.length, 1);
    assert.equal(f.authRuntime.store.snapshot().personSessions[0].id, id);
    await cdp('click', route, '[data-testid=account-menu]');
    await cdp('click', route, '#session-media-proof');
    await waitFor(
      "Array.from(document.querySelector('media-lightbox')?.shadowRoot?.querySelectorAll('.ml-md-content img') ?? []).some(img => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0)",
    );
    await cdp('screenshot', route, output + '/authenticated-report-media.png');
    await cdp('click', route, 'media-lightbox >>> .ml-actions .ml-btn:last-child');
    await cdp('click', route, '[data-testid=account-sign-out]');
    await cdp('click', route, '[data-testid=account-sign-out-cancel]');
    assert.equal(f.authRuntime.store.snapshot().personSessions[0].revokedAt, null);
    await cdp('click', route, '[data-testid=account-sign-out]');
    await cdp('click', route, '[data-testid=account-sign-out-confirm]');
    await waitFor("document.querySelector('.auth-card')");
    assert.ok(f.authRuntime.store.snapshot().personSessions[0].revokedAt);
    await cdp('screenshot', route, output + '/signed-out.png');
    await cdp('close', route);
    tabOpen = false;
    await writeFile(
      output + '/receipt.json',
      JSON.stringify(
        {
          result: 'PASS',
          sessionCount: 1,
          sameDeviceAfterReload: true,
          cancelPreservedLogin: true,
          serverRevocationConfirmed: true,
          authenticatedReportMedia: true,
          proofTabClosed: true,
          proofDeviceCreated: false,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
