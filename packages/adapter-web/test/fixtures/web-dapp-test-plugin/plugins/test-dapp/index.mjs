// A testnet-only plugin for MetaMask's test-dapp-multichain, as an adapter that
// extends web-dapp: the generic slot browser, wallet host and strict injected
// wallet, with a venue policy that holds the run to testnet and local hosts.
// Declared in ../../recipe-library.json `adapters`.

import { policy } from './policy.mjs';

export const testDappAdapter = {
  id: 'test-dapp',
  sdkVersion: 1,
  extends: 'web-dapp',
  policy,
};
