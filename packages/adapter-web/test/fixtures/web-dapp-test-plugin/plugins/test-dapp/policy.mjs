// The venue policy of the test-dapp plugin: test-dapp-multichain held to
// testnets. Node built-ins only, and everything it imports stays in this
// directory: web-dapp's leaf processes load this module by path (`module`).
//
// This dapp needs signer=extension, with a host signer module (MetaMask's, for
// mm-harness). It talks to the wallet through the Multichain API (the extension
// connection / window.postMessage), not EIP-1193 or EIP-6963, so the injected
// strict wallet cannot drive it. The page makes no EVM RPC of its own (the
// wallet's RPC goes out from the extension, which the wallet host does not
// observe), so `served` is empty on purpose: the served-network check is not
// applicable, and only the mainnet block (the hosts below) is enforced.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mainnet endpoints the browser must never reach: Ethereum, and the Solana
// mainnet hosts the page fetches blockhashes from (src/helpers/solana-method-signatures.ts).
// A Solana action therefore logs blocked-mainnet entries before the page falls
// back to devnet (api.devnet.solana.com), which stays reachable.
const MAINNET_HOSTS = [
  'mainnet.infura.io',
  'eth-mainnet.g.alchemy.com',
  'cloudflare-eth.com',
  'api.mainnet-beta.solana.com',
  'api.helius-rpc.com',
];
// No served hosts: the page makes no venue request of its own at startup, and
// the Solana devnet host it falls back to appears only on a Solana action, so
// listing it would make the launch wait for traffic that may never come.
const TESTNET_HOSTS = [];
const SEPOLIA = 11155111;

function isTestDappCheckout(target) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
    return (
      pkg.name === '@metamask/test-dapp-multichain' ||
      pkg.name === 'test-dapp-multichain' ||
      existsSync(path.join(target, 'test-dapp-multichain.config.json'))
    );
  } catch {
    return false;
  }
}

// Refuses typed data signed for Ethereum mainnet. Self-contained: it also runs in the page.
function mainnetReason(data) {
  const chainId = Number(data?.domain?.chainId);
  return chainId === 1 ? 'domain.chainId=1 (Ethereum mainnet)' : null;
}

export const policy = Object.freeze({
  policyVersion: 1,
  adapterId: 'test-dapp',
  checkout: Object.freeze({
    matches: isTestDappCheckout,
    name: 'test-dapp-multichain',
    label: 'test-dapp-multichain checkout',
    needs: 'a package named @metamask/test-dapp-multichain',
  }),
  venueHosts() {
    return { blocked: [...MAINNET_HOSTS], served: [...TESTNET_HOSTS] };
  },
  // Pages the app links to, never blocked and never proof of the served network.
  linkHosts: Object.freeze(['metamask.github.io']),
  probe: Object.freeze({
    host: 'mainnet.infura.io',
    httpPath: '/v3/probe',
    httpBody: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
    wsPath: '/ws/v3/probe',
  }),
  startChain: SEPOLIA,
  refuseTypedData: Object.freeze({
    reason: mainnetReason,
    kind: 'refused-mainnet',
    message: 'Refused: this run is held to testnets and the request signs for Ethereum mainnet.',
  }),
  signatureLog: Object.freeze({
    typedDataClasses: {},
    forbiddenEntries: {
      blockedMainnet: {
        match: (entry) => entry.kind === 'blocked-mainnet' && !entry.probe,
        failure: (count) =>
          `the browser tried to reach a mainnet endpoint ${count} time(s) (blocked-mainnet)`,
      },
      refusedMainnet: {
        match: (entry) => entry.kind === 'refused-mainnet',
        failure: (count) =>
          `the app asked the wallet to sign ${count} mainnet request(s) (refused-mainnet)`,
      },
    },
  }),
  startPath: '/',
  pagePath(node = {}) {
    const page = node.page == null ? 'home' : String(node.page);
    if (page === 'home') return '/';
    throw new Error(`ui.navigate page must be home (or pass path), got ${JSON.stringify(page)}.`);
  },
  dependencies: Object.freeze([]),
  testnetVariable: 'TEST_DAPP_TESTNET_ONLY',
  module: fileURLToPath(import.meta.url),
});
