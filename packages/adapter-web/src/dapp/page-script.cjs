'use strict';

// Source of the script a wallet host evaluates in every app document before
// page scripts. It reports each wallet request the app makes (method, EIP-712
// primary type, domain/active chain, outcome; no params or signatures) through
// a CDP binding, and with the injected signer also provides an EIP-1193
// provider, announced over EIP-6963, whose requests the host answers. It
// installs itself only in the top frame of a document on the exact app origin:
// the CDP preload also runs in iframes and after the tab navigates elsewhere.
// Errors are logged as a code and a fixed category, never as provider text.
//
// Policy is an input: `refuseTypedData` names the typed data the run must never
// sign (its reason function runs in the page), `injectedWallet` the identity
// the injected provider announces.

const LOG_BINDING = '__farmslotWalletLog';
const REQUEST_BINDING = '__farmslotWalletRequest';
const RESOLVE_FN = '__farmslotWalletResolve';
// The marker the preload leaves on the window; pageReadyExpression reads it.
const PAGE_MARKER = '__farmslotDapp';

const LOGGED_METHODS = Object.freeze([
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'personal_sign',
  'eth_sign',
  'eth_sendTransaction',
]);

const ERROR_CATEGORIES = Object.freeze({
  4001: 'user-rejected',
  4100: 'unauthorized',
  4200: 'unsupported-method',
  4900: 'disconnected',
  4901: 'chain-disconnected',
  4902: 'unrecognized-chain',
  [-32602]: 'invalid-params',
  [-32603]: 'internal',
});

function pageMain(config, refusalReason) {
  if (window.top !== window || location.origin !== config.appOrigin) return;
  if (window[config.marker]) return;
  // The wallet host's ready check reads this marker on the committed document:
  // the preload ran, and the page's provider is wrapped (covers).
  const wrapped = new WeakSet();
  const harness = {
    signer: config.signer,
    refusesTypedData: Boolean(config.refusal),
    wrapped: 0,
    wrapFailures: [],
    covers: (provider) => Boolean(provider) && wrapped.has(provider),
  };
  window[config.marker] = harness;
  const logged = new Set(config.loggedMethods);
  // Without the host's binding a wallet request would go unrecorded, so it is
  // refused (fail closed) rather than passed through.
  const unrecorded = () =>
    Object.assign(
      new Error(
        'The harness wallet host is not attached to this document; the request was refused so it cannot go unrecorded.',
      ),
      { code: 4100 },
    );
  const hasBinding = (binding) => typeof window[binding] === 'function';
  const report = (entry) => {
    try {
      window[config.logBinding](JSON.stringify(entry));
    } catch {
      // Binding unavailable (host detached): the request still proceeds.
    }
  };
  const describe = (method, params) => {
    const entry = { kind: 'request', method, t: Date.now(), url: location.pathname };
    if (/^eth_signTypedData/.test(method)) {
      try {
        const raw = params?.[1];
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        entry.primaryType = data?.primaryType ?? null;
        entry.domainName = data?.domain?.name ?? null;
        entry.domainChainId =
          data?.domain?.chainId == null ? null : Number(BigInt(data.domain.chainId));
      } catch {
        entry.primaryType = null;
      }
    }
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
      try {
        entry.toChainId = Number.parseInt(params[0].chainId, 16);
      } catch {
        entry.toChainId = null;
      }
    }
    return entry;
  };
  const wrap = (provider, source) => {
    if (!provider || typeof provider.request !== 'function' || wrapped.has(provider))
      return provider;
    const original = provider.request.bind(provider);
    const request = async (args) => {
      const method = args?.method;
      if (!logged.has(method)) return original(args);
      if (!hasBinding(config.logBinding)) throw unrecorded();
      const entry = { ...describe(method, args?.params), source };
      // Typed data the run must never sign never reaches the signer.
      if (config.refusal && /^eth_signTypedData/.test(method)) {
        let reason = null;
        try {
          const raw = args?.params?.[1];
          reason = refusalReason(typeof raw === 'string' ? JSON.parse(raw) : raw);
        } catch {
          reason = null;
        }
        if (reason) {
          report({
            ...entry,
            kind: config.refusal.kind,
            reason,
            outcome: 'refused',
            errorCode: 4100,
          });
          throw Object.assign(new Error(config.refusal.message), { code: 4100 });
        }
      }
      try {
        entry.activeChainId = Number.parseInt(await original({ method: 'eth_chainId' }), 16);
      } catch {
        entry.activeChainId = null;
      }
      const started = Date.now();
      try {
        const result = await original(args);
        entry.outcome = /sign/i.test(method) ? 'signed' : 'approved';
        entry.durationMs = Date.now() - started;
        report(entry);
        return result;
      } catch (error) {
        const code = Number.isInteger(error?.code) ? error.code : null;
        entry.outcome = code === 4001 ? 'rejected' : 'error';
        entry.errorCode = code;
        entry.errorCategory = config.errorCategories[code] ?? 'other';
        entry.durationMs = Date.now() - started;
        report(entry);
        throw error;
      }
    };
    try {
      provider.request = request;
    } catch {
      // Read-only property: define it instead (below).
    }
    if (provider.request !== request) {
      try {
        Object.defineProperty(provider, 'request', {
          value: request,
          configurable: true,
          writable: true,
        });
      } catch {
        // Frozen provider: recorded below.
      }
    }
    // A provider whose request could not be replaced would sign unrecorded.
    if (provider.request !== request) {
      harness.wrapFailures.push(source);
      return provider;
    }
    wrapped.add(provider);
    harness.wrapped += 1;
    return provider;
  };

  if (config.signer === 'injected') {
    const listeners = {};
    const emit = (event, ...args) =>
      (listeners[event] ?? []).forEach((fn) => {
        try {
          fn(...args);
        } catch {
          /* listener errors stay in the app */
        }
      });
    const pending = new Map();
    let nextId = 1;
    window[config.resolveFn] = (id, outcome) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (outcome.error)
        entry.reject(Object.assign(new Error(outcome.error.message), { code: outcome.error.code }));
      else entry.resolve(outcome.result);
    };
    let lastChain = null;
    const provider = {
      ...(config.injectedWallet.isMetaMask
        ? { isMetaMask: true, _metamask: { isUnlocked: async () => true } }
        : {}),
      request: ({ method, params }) =>
        new Promise((resolve, reject) => {
          if (!hasBinding(config.requestBinding)) {
            reject(unrecorded());
            return;
          }
          const id = nextId++;
          pending.set(id, { resolve, reject });
          window[config.requestBinding](JSON.stringify({ id, method, params }));
        }).then((result) => {
          if (method === 'wallet_switchEthereumChain' && params?.[0]?.chainId !== lastChain) {
            lastChain = params[0].chainId;
            emit('chainChanged', lastChain);
          }
          if (method === 'eth_chainId') lastChain = result;
          if (method === 'eth_requestAccounts') emit('connect', { chainId: lastChain ?? '0x1' });
          return result;
        }),
      on: (event, fn) => {
        (listeners[event] ??= []).push(fn);
        return provider;
      },
      removeListener: (event, fn) => {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        return provider;
      },
      enable: () => provider.request({ method: 'eth_requestAccounts' }),
    };
    wrap(provider, 'injected-strict-wallet');
    window.ethereum = provider;
    const info = config.injectedWallet.info;
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
      );
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
    return;
  }

  // Extension mode: wrap whatever provider the wallet extension injects,
  // however the app reaches it (window.ethereum or an EIP-6963 announcement).
  let current = window.ethereum ? wrap(window.ethereum, 'window.ethereum') : undefined;
  try {
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      get: () => current,
      set: (value) => {
        current = wrap(value, 'window.ethereum');
      },
    });
  } catch {
    // A non-configurable window.ethereum is still wrapped by the poll below.
  }
  window.addEventListener(
    'eip6963:announceProvider',
    (event) => {
      wrap(event.detail?.provider, `eip6963:${event.detail?.info?.rdns ?? 'unknown'}`);
    },
    true,
  );
  let polls = 0;
  const poll = setInterval(() => {
    if (window.ethereum) wrap(window.ethereum, 'window.ethereum');
    if (++polls > 200) clearInterval(poll);
  }, 50);
}

/**
 * @typedef {object} TypedDataRefusal
 * @property {(typedData: any) => string | null} reason Why the run must not sign this typed data, or null. Runs in the page too: self-contained (no closure, no imports).
 * @property {string} kind The log entry kind of a refusal.
 * @property {string} message The refusal's error message (code 4100).
 */

/**
 * @typedef {object} InjectedWallet
 * @property {{ uuid: string, name: string, icon: string, rdns: string }} info EIP-6963 provider info to announce.
 * @property {boolean} [isMetaMask] Present the provider as MetaMask (`isMetaMask`, `_metamask.isUnlocked`).
 */

/**
 * The preload for one app origin.
 * - `signer`: 'extension' wraps the provider a wallet extension injects;
 *   'injected' provides one whose requests go to the host (REQUEST_BINDING).
 * - `refuseTypedData`: `{ reason, kind, message }` or null. `reason(typedData)`
 *   returns why the run must not sign it, or null; it runs in the page, so it
 *   must be a self-contained function (no closure, no imports). A refusal is
 *   logged as `kind` and answered with code 4100 and `message`.
 * - `injectedWallet` (injected signer): `{ info, isMetaMask }`, the EIP-6963
 *   provider info to announce and whether the provider presents as MetaMask.
 *
 * @param {{ signer: 'extension' | 'injected', appOrigin: string, refuseTypedData?: TypedDataRefusal | null, injectedWallet?: InjectedWallet }} options
 * @returns {string}
 */
function pageScriptSource({ signer, appOrigin, refuseTypedData = null, injectedWallet }) {
  if (signer !== 'extension' && signer !== 'injected') {
    throw new Error(`signer must be extension or injected, got ${JSON.stringify(signer)}.`);
  }
  if (refuseTypedData && typeof refuseTypedData.reason !== 'function') {
    throw new Error('refuseTypedData.reason must be a function.');
  }
  if (signer === 'injected' && !injectedWallet?.info?.rdns) {
    throw new Error('the injected signer needs injectedWallet.info (EIP-6963 provider info).');
  }
  const config = {
    signer,
    appOrigin: new URL(appOrigin).origin,
    refusal: refuseTypedData
      ? { kind: refuseTypedData.kind, message: refuseTypedData.message }
      : null,
    injectedWallet:
      signer === 'injected'
        ? { info: injectedWallet.info, isMetaMask: injectedWallet.isMetaMask === true }
        : null,
    errorCategories: ERROR_CATEGORIES,
    loggedMethods: LOGGED_METHODS,
    marker: PAGE_MARKER,
    logBinding: LOG_BINDING,
    requestBinding: REQUEST_BINDING,
    resolveFn: RESOLVE_FN,
  };
  const reason = refuseTypedData ? refuseTypedData.reason.toString() : 'null';
  return `(${pageMain.toString()})(${JSON.stringify(config)}, ${reason});`;
}

/**
 * An expression that is true on a document whose preload is installed for
 * this signer and policy, whose bindings are attached, and whose provider the
 * app sees (window.ethereum) is wrapped with no wrap failure.
 *
 * @param {{ signer: 'extension' | 'injected', refusesTypedData: boolean }} options
 * @returns {string}
 */
function pageReadyExpression({ signer, refusesTypedData }) {
  return [
    `typeof window.${LOG_BINDING} === 'function'`,
    ...(signer === 'injected' ? [`typeof window.${REQUEST_BINDING} === 'function'`] : []),
    `Boolean(window.${PAGE_MARKER} && window.${PAGE_MARKER}.signer === ${JSON.stringify(signer)} && window.${PAGE_MARKER}.refusesTypedData === ${refusesTypedData === true})`,
    `window.${PAGE_MARKER}.wrapFailures.length === 0 && window.${PAGE_MARKER}.covers(window.ethereum)`,
  ].join(' && ');
}

module.exports = {
  ERROR_CATEGORIES,
  LOGGED_METHODS,
  LOG_BINDING,
  PAGE_MARKER,
  REQUEST_BINDING,
  RESOLVE_FN,
  pageReadyExpression,
  pageScriptSource,
};
