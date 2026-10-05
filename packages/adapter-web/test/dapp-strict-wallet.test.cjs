'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createStrictWallet } = require('../src/dapp/strict-wallet.cjs');

// A stand-in signer: records what the wallet asks it to sign.
function fakeAccount(address = '0x00000000000000000000000000000000000000aa') {
  const signed = [];
  return {
    address,
    signed,
    async signTypedData(args) {
      signed.push(args);
      return `0x${'1'.repeat(130)}`;
    },
    async signMessage(args) {
      signed.push(args);
      return `0x${'2'.repeat(130)}`;
    },
  };
}

function typedData(chainId, primaryType = 'Permit') {
  return JSON.stringify({
    domain: {
      name: 'Test',
      version: '1',
      chainId,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      EIP712Domain: [],
      [primaryType]: [
        { name: 'label', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType,
    message: { label: 'test', nonce: 1 },
  });
}

describe('strict test wallet', () => {
  it('signs typed data whose domain chainId is the active chain, with integer fields as bigint', async () => {
    const account = fakeAccount();
    const wallet = createStrictWallet({ account, chainId: 42161 });
    const signature = await wallet.request({
      method: 'eth_signTypedData_v4',
      params: [account.address, typedData(42161)],
    });
    assert.match(signature, /^0x[0-9a-f]{130}$/);
    assert.deepEqual(account.signed[0].message, { label: 'test', nonce: 1n });
    assert.equal(account.signed[0].types.EIP712Domain, undefined);
    assert.equal(account.signed[0].domain.chainId, 42161);
  });

  it('rejects a domain chainId that differs from the active chain, as MetaMask does', async () => {
    const account = fakeAccount();
    const wallet = createStrictWallet({ account, chainId: 42161 });
    await assert.rejects(
      wallet.request({ method: 'eth_signTypedData_v4', params: [account.address, typedData(1)] }),
      { code: -32602, message: /must match the active chainId "42161"/ },
    );
    assert.equal(account.signed.length, 0);
  });

  it('switches to known chains, refuses unknown ones and honours refuseSwitch', async () => {
    const wallet = createStrictWallet({ account: fakeAccount(), chainId: 42161 });
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    assert.equal(await wallet.request({ method: 'eth_chainId' }), '0x1');
    await assert.rejects(
      wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x539' }] }),
      { code: 4902 },
    );
    const refusing = createStrictWallet({
      account: fakeAccount(),
      chainId: 42161,
      refuseSwitch: true,
    });
    await assert.rejects(
      refusing.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }),
      { code: 4001 },
    );
  });

  it('refuses to sign for another account and refuses transactions', async () => {
    const wallet = createStrictWallet({ account: fakeAccount(), chainId: 1 });
    await assert.rejects(
      wallet.request({
        method: 'eth_signTypedData_v4',
        params: ['0x0000000000000000000000000000000000000001', typedData(1)],
      }),
      { code: 4100 },
    );
    await assert.rejects(
      wallet.request({
        method: 'personal_sign',
        params: ['0x00', '0x0000000000000000000000000000000000000001'],
      }),
      { code: 4100 },
    );
    await assert.rejects(wallet.request({ method: 'eth_sendTransaction', params: [{}] }), {
      code: 4200,
    });
  });

  it('refuses transaction submission before any network request', async () => {
    const calls = [];
    const wallet = createStrictWallet({
      account: fakeAccount(),
      chainId: 1,
      fetchImpl: async (...args) => {
        calls.push(args);
        throw new Error('no network');
      },
    });
    await assert.rejects(wallet.request({ method: 'eth_sendRawTransaction', params: ['0x02'] }), {
      code: 4200,
    });
    await assert.rejects(wallet.request({ method: 'eth_signTransaction', params: [{}] }), {
      code: 4200,
    });
    await assert.rejects(wallet.request({ method: 'wallet_sendCalls', params: [{}] }), {
      code: 4200,
    });
    assert.equal(calls.length, 0);
  });

  it('forwards reads to the public RPC of the active chain', async () => {
    const calls = [];
    const account = fakeAccount();
    const wallet = createStrictWallet({
      account,
      chainId: 1,
      fetchImpl: async (url, init) => {
        calls.push([url, JSON.parse(init.body).method]);
        return { json: async () => ({ result: '0x10' }) };
      },
    });
    assert.equal(
      await wallet.request({ method: 'eth_getBalance', params: [account.address, 'latest'] }),
      '0x10',
    );
    assert.deepEqual(calls, [['https://ethereum-rpc.publicnode.com', 'eth_getBalance']]);
  });
});
