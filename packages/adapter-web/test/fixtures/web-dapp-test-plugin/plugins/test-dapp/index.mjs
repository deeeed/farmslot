// A testnet-only plugin for MetaMask's test-dapp-multichain, as an adapter that
// extends web-dapp: the generic slot browser and wallet host, with a venue
// policy that blocks the mainnet hosts. The dapp needs signer=extension (a host
// signer module): the injected strict wallet cannot drive the Multichain API.
// Declared in ../../recipe-library.json `adapters`.

import { policy } from './policy.mjs';

export const testDappAdapter = {
  id: 'test-dapp',
  sdkVersion: 1,
  extends: 'web-dapp',
  policy,
};
