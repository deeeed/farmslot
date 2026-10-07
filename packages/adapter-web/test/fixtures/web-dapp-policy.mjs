// A venue policy for web-dapp's tests: the shape an adapter that extends
// web-dapp hands it (the Terminal plugin's plugins/terminal/policy.mjs in the
// recipe-terminal library), with fixed test hosts the stub browser
// (web-dapp-stub-browser.mjs) answers for. Tests point RECIPE_WEB_DAPP_POLICY here.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCKED = ['api.hyperliquid.xyz', 'rpc.hyperliquid.xyz'];
const SERVED = ['api.hyperliquid-testnet.xyz'];

function isExampleCheckout(target) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
    return (
      Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.next) &&
      existsSync(path.join(target, 'src/features/perpetuals'))
    );
  } catch {
    return false;
  }
}

// Refuses typed data whose message says mainnet; self-contained (it also runs in the page).
function testMainnetReason(data) {
  const message = data?.message ?? {};
  if (
    typeof message.hyperliquidChain === 'string' &&
    message.hyperliquidChain.toLowerCase() === 'mainnet'
  )
    return 'hyperliquidChain=Mainnet';
  if (data?.primaryType === 'Agent' && message.source === 'a') return 'L1 Agent source=a';
  return null;
}

const isL1 = (entry) =>
  entry.kind === 'request' &&
  /^eth_signTypedData/u.test(String(entry.method)) &&
  (String(entry.primaryType ?? '')
    .split(':')
    .pop() === 'Agent' ||
    Number(entry.domainChainId) === 1337);

export const policy = Object.freeze({
  policyVersion: 1,
  adapterId: 'terminal',
  checkout: Object.freeze({
    matches: isExampleCheckout,
    name: 'Web Terminal',
    label: 'Next.js checkout with src/features/perpetuals',
    needs: 'next + src/features/perpetuals',
  }),
  // A test can change the venue's hosts by writing <checkout>/venue-hosts.json.
  venueHosts(checkout) {
    const file = path.join(checkout, 'venue-hosts.json');
    return existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { blocked: [...BLOCKED], served: [...SERVED] };
  },
  linkHosts: Object.freeze(['app.hyperliquid.xyz', 'app.hyperliquid-testnet.xyz']),
  probe: Object.freeze({
    host: 'api.hyperliquid.xyz',
    httpPath: '/info',
    httpBody: '{"type":"meta"}',
    wsPath: '/ws',
  }),
  startChain: 42161,
  refuseTypedData: Object.freeze({
    reason: testMainnetReason,
    kind: 'refused-mainnet',
    message:
      'Refused: this test run is held to Hyperliquid testnet and the request signs a mainnet action.',
  }),
  signatureLog: Object.freeze({
    typedDataClasses: {
      l1Requests: {
        match: isL1,
        param: 'max_l1_requests',
        defaultMax: 0,
        failure: (count, max) => `L1 requests reached the main wallet: ${count} > ${max}`,
      },
    },
    forbiddenEntries: {
      blockedMainnet: {
        match: (entry) => entry.kind === 'blocked-mainnet' && !entry.probe,
        failure: (count) =>
          `the browser tried to reach a mainnet venue ${count} time(s) (blocked-mainnet)`,
      },
      refusedMainnet: {
        match: (entry) => entry.kind === 'refused-mainnet',
        failure: (count) =>
          `the app asked the wallet to sign ${count} mainnet action(s) (refused-mainnet)`,
      },
    },
  }),
  startPath: '/order/BTC',
  pagePath(node = {}) {
    const page = node.page == null ? 'order' : String(node.page);
    if (page === 'order' || page === 'market')
      return `/order/${String(node.market ?? node.symbol ?? 'BTC').toUpperCase()}`;
    if (page === 'portfolio') return '/portfolio';
    if (page === 'home') return '/';
    throw new Error(
      `ui.navigate page must be order, portfolio or home (or pass path), got ${JSON.stringify(page)}.`,
    );
  },
  dependencies: Object.freeze(['next', '@nktkas/hyperliquid', '@metamask/perps-controller']),
  testnetVariable: 'NEXT_PUBLIC_HYPERLIQUID_FORCE_TESTNET',
  module: fileURLToPath(import.meta.url),
});
