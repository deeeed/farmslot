// A stand-in for a host's extension signer module (what mm-harness ships for
// MetaMask): the hooks web-dapp calls for signer=extension, with no wallet
// behind them. Behaviour comes from env:
//   TEST_SIGNER_FAIL  prepare | after   throw from that hook (after the secret files exist)
//   TEST_SIGNER_ID    the extension id it reports (default stubextension)
// It writes the same per-slot key files a real signer does, so tests can prove
// the launcher removes them when a launch fails.

import path from 'node:path';

const WALLET_SURFACES = ['sidepanel.html', 'notification.html', 'popup.html'];
const CONFIRMATION_ROUTE =
  /^\/(connect|confirm-transaction|confirmation|confirm|signature-request)(\/|$)/u;

export const signers = {
  extension: {
    async prepareProfile({ runtime, account, env, trackSecret, writePrivateFile }) {
      const slotFixture = trackSecret(path.join(runtime, `wallet-fixture.${account}.json`));
      const fixtureState = trackSecret(path.join(runtime, `fixture-state.${account}.json`));
      writePrivateFile(slotFixture, '{}');
      writePrivateFile(fixtureState, '{}');
      if (env.TEST_SIGNER_FAIL === 'prepare') throw new Error('test signer: prepareProfile failed');
      const id = env.TEST_SIGNER_ID ?? 'stubextension';
      return {
        browserArgs: [`--test-signer-extension=${id}`],
        secrets: [],
        state: { id, version: '0.0.0' },
        async afterBrowserStart({ log }) {
          if (env.TEST_SIGNER_FAIL === 'after')
            throw new Error('test signer: afterBrowserStart failed');
          log(`test signer ${id} ready for ${account}`);
          return { hostArgs: ['--extension-id', id], state: { seeded: true } };
        },
      };
    },

    // Wallet surfaces: the side panel, notification and popup pages of the extension.
    confirm({ args, appendEntry, say, focus }) {
      const extensionOrigin = args['extension-id']
        ? `chrome-extension://${args['extension-id']}`
        : null;
      const seen = new Map();
      const isWalletSurfaceUrl = (url) =>
        Boolean(extensionOrigin) &&
        WALLET_SURFACES.some((surface) => url.startsWith(`${extensionOrigin}/${surface}`));
      const routeOf = (url) => {
        const route = (url.split('#')[1] ?? '').split('?')[0];
        return CONFIRMATION_ROUTE.test(route)
          ? route.replace(/0x[0-9a-fA-F]{40}/gu, '<address>')
          : null;
      };
      return {
        isWalletSurfaceUrl,
        observe(targetId, url) {
          if (!isWalletSurfaceUrl(url)) return;
          if (focus && !url.includes('/sidepanel.html') && !seen.has(targetId)) {
            setTimeout(
              () =>
                focus.observe(
                  url.includes('/popup.html') ? 'popup' : 'notification',
                  'Test wallet',
                ),
              1000,
            );
          }
          const route = routeOf(url);
          if (!route || seen.get(targetId) === route) return;
          seen.set(targetId, route);
          const surface = WALLET_SURFACES.find((name) => url.includes(name))?.replace('.html', '');
          appendEntry({ kind: 'confirmation-shown', t: Date.now(), surface, route });
          say(`confirmation shown in ${surface}: ${route}`);
        },
      };
    },

    async readinessChecks({ required }) {
      return [{ id: 'test-signer', status: 'pass', required, detail: 'test signer module loaded' }];
    },
  },
};
