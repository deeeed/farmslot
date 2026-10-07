// Signer hooks for the extension signer (signer=extension). The wallet that
// drives a real browser extension is the host product's (MetaMask's, for
// mm-harness), so web-dapp's launcher, wallet host and readiness call it
// through hooks instead of knowing it. signer=injected needs none: the strict
// test wallet in @farmslot/adapter-web/dapp is generic.
//
// A signer module is an ESM file exporting `signers`, an object keyed by signer
// mode (today only `extension`):
//
//   export const signers = { extension: {
//     // Before the browser starts: load the extension and seed the profile.
//     // Returns { browserArgs, secrets, state, afterBrowserStart? }:
//     //   browserArgs   extra browser arguments (--load-extension=...)
//     //   secrets       files holding key material, removed when the launch ends
//     //   state         recorded under `extension` in browser.json
//     //   afterBrowserStart(ctx)  runs once the browser answers on CDP; ctx is
//     //     { cdpPort, launchMethod, windowBounds, withBrowserClient,
//     //       openBackgroundWindow(url), log }. May return { state, hostArgs }:
//     //     state merges into the recorded state, hostArgs go to the wallet host.
//     // `trackSecret(file)` registers a key-material file at once, so it is removed
//     // even when prepareProfile throws part-way; `secrets` may list more.
//     async prepareProfile({ target, runtime, profile, account, fixture, env,
//                            freshProfile, log, writePrivateFile, trackSecret }) {},
//     // In the wallet host: judge the wallet's own confirmation surfaces. Returns
//     // { isWalletSurfaceUrl(url), observe(targetId, url) }; `args` are the wallet
//     // host's flags (e.g. args['extension-id']). `focus`, when the host observes
//     // focus, has observe(surface, productName) to record a window that took it.
//     confirm({ args, appendEntry, say, focus }) {},
//     // In readiness: the signer's own checks (build them with `check` from
//     // readiness.mjs), `required` when signer=extension is requested.
//     async readinessChecks({ target, env, required }) {},
//   } };
//
// The module may also export `injected: { identity }`: the EIP-6963 identity
// ({ info: { uuid, name, icon, rdns }, isMetaMask }) the injected strict wallet
// presents, for an app that only connects to a known wallet. Without it the
// strict wallet presents a generic identity.
//
// A leaf process finds the module through RECIPE_WEB_DAPP_SIGNER_MODULE (or
// --signer-module on launch and verify).

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SIGNER_MODULE_ENV = 'RECIPE_WEB_DAPP_SIGNER_MODULE';

export async function loadSigners(env = process.env) {
  const file = env[SIGNER_MODULE_ENV];
  if (!file) return {};
  const resolved = path.resolve(file);
  const loaded = await import(pathToFileURL(resolved).href);
  const signers = loaded.signers ?? loaded.default;
  if (!signers || typeof signers !== 'object') {
    throw new Error(
      `web-dapp signer module ${resolved} must export \`signers\`, an object keyed by signer mode.`,
    );
  }
  return signers;
}

// The injected strict wallet's EIP-6963 identity: the signer module's
// `injected.identity` when it gives one (a host whose app only connects to a
// known wallet, e.g. mm-harness presenting MetaMask so the app connects to it
// the way it connects to the extension), else a generic one.
export const GENERIC_INJECTED_IDENTITY = Object.freeze({
  info: Object.freeze({
    uuid: '5d1e5b4e-e2e0-4c3f-9a1d-000000000001',
    name: 'Strict test wallet',
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    rdns: 'io.farmslot.strict-wallet',
  }),
  isMetaMask: false,
});

export function injectedWalletIdentity(signers = {}) {
  const identity = signers.injected?.identity;
  if (identity === undefined) return GENERIC_INJECTED_IDENTITY;
  const info = identity?.info;
  if (
    !info ||
    typeof info.uuid !== 'string' ||
    typeof info.name !== 'string' ||
    typeof info.rdns !== 'string'
  ) {
    throw new Error(
      'web-dapp signer module: injected.identity needs info.uuid, info.name and info.rdns strings.',
    );
  }
  return identity;
}
