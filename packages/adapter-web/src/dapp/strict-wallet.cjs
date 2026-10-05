'use strict';

// EIP-1193 test wallet that enforces MetaMask's typed-data rule: reject
// eth_signTypedData_v4 whose domain chainId differs from the active chain.
// Signs with a viem-style account ({ address, signTypedData, signMessage })
// the caller holds; never exposes key material.

const DEFAULT_KNOWN_CHAINS = Object.freeze([
  1, 10, 137, 8453, 42161, 421614, 59144, 59141, 11155111,
]);

const READ_RPC = {
  1: 'https://ethereum-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  421614: 'https://arbitrum-sepolia-rpc.publicnode.com',
  59144: 'https://linea-rpc.publicnode.com',
};

// Only these reads go to the public RPC. Anything else the wallet does not
// answer itself (eth_sendRawTransaction, account or filter methods, unknown
// wallet_* calls) is refused before any network request.
const READ_ONLY_RPC_METHODS = Object.freeze([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'web3_clientVersion',
]);
const READ_ONLY = new Set(READ_ONLY_RPC_METHODS);

function rpcError(message, code) {
  return Object.assign(new Error(message), { code });
}

function toBigIntDeep(types, primaryType, message) {
  const out = {};
  for (const field of types[primaryType] ?? []) {
    const value = message[field.name];
    if (value === undefined) continue;
    if (/^u?int\d*$/u.test(field.type)) out[field.name] = BigInt(value);
    else if (types[field.type]) out[field.name] = toBigIntDeep(types, field.type, value);
    else out[field.name] = value;
  }
  return out;
}

/**
 * @param {object} options
 * @param {{ address: string, signTypedData(args: any): Promise<string>, signMessage(args: any): Promise<string> }} options.account
 * @param {number} [options.chainId]
 * @param {readonly number[]} [options.knownChains]
 * @param {boolean} [options.refuseSwitch]
 * @param {typeof fetch} [options.fetchImpl]
 */
function createStrictWallet({
  account,
  chainId = 42161,
  knownChains = DEFAULT_KNOWN_CHAINS,
  refuseSwitch = false,
  fetchImpl = globalThis.fetch,
}) {
  let activeChain = chainId;
  const known = new Set(knownChains);
  let rpcId = 1;

  async function request({ method, params = [] }) {
    switch (method) {
      case 'eth_chainId':
        return `0x${activeChain.toString(16)}`;
      case 'net_version':
        return String(activeChain);
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [account.address];
      case 'wallet_requestPermissions':
      case 'wallet_getPermissions':
        return [
          {
            parentCapability: 'eth_accounts',
            caveats: [{ type: 'restrictReturnedAccounts', value: [account.address.toLowerCase()] }],
          },
        ];
      case 'wallet_revokePermissions':
        return null;
      case 'metamask_getProviderState':
        return {
          accounts: [account.address.toLowerCase()],
          chainId: `0x${activeChain.toString(16)}`,
          isUnlocked: true,
          networkVersion: String(activeChain),
        };
      case 'wallet_switchEthereumChain': {
        const id = Number.parseInt(params[0].chainId, 16);
        if (refuseSwitch) throw rpcError('User rejected the request.', 4001);
        if (!known.has(id)) throw rpcError(`Unrecognized chain ID ${params[0].chainId}`, 4902);
        activeChain = id;
        return null;
      }
      case 'wallet_addEthereumChain':
        known.add(Number.parseInt(params[0].chainId, 16));
        return null;
      case 'eth_signTypedData_v4': {
        const [from, raw] = params;
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const domainChain = Number(BigInt(data.domain.chainId));
        if (String(from).toLowerCase() !== account.address.toLowerCase())
          throw rpcError('Unknown account', 4100);
        if (domainChain !== activeChain) {
          throw rpcError(
            `Provided chainId "${domainChain}" must match the active chainId "${activeChain}"`,
            -32602,
          );
        }
        const types = { ...data.types };
        delete types.EIP712Domain;
        return account.signTypedData({
          domain: { ...data.domain, chainId: domainChain },
          types,
          primaryType: data.primaryType,
          message: toBigIntDeep(types, data.primaryType, data.message),
        });
      }
      case 'personal_sign': {
        const [message, from] = params;
        if (String(from).toLowerCase() !== account.address.toLowerCase())
          throw rpcError('Unknown account', 4100);
        return account.signMessage({ message: { raw: message } });
      }
      case 'eth_sendTransaction':
      case 'eth_sign':
        throw rpcError(`${method} is not supported by the strict test wallet`, 4200);
      default: {
        if (!READ_ONLY.has(method))
          throw rpcError(`${method} is not supported by the strict test wallet`, 4200);
        const url = READ_RPC[activeChain];
        if (!url) throw rpcError(`No read RPC for chain ${activeChain}`, 4200);
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        });
        const body = await response.json();
        if (body.error) throw rpcError(body.error.message, body.error.code);
        return body.result;
      }
    }
  }

  return {
    request,
    get chainId() {
      return activeChain;
    },
  };
}

module.exports = { DEFAULT_KNOWN_CHAINS, READ_ONLY_RPC_METHODS, createStrictWallet };
