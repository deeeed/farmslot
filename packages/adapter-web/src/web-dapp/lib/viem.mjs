// viem is the account derivation the wallet fixture needs (mnemonic and private
// key accounts). adapter-web does not depend on it: it is resolved from the app
// checkout under test (the Next.js app carries viem), else from where
// adapter-web is installed, else from the working directory.

import { createRequire } from 'node:module';
import path from 'node:path';

export function loadViemAccounts(projectRoot) {
  const bases = [
    ...(projectRoot ? [path.join(path.resolve(projectRoot), 'package.json')] : []),
    import.meta.url,
    path.join(process.cwd(), 'package.json'),
  ];
  for (const base of bases) {
    try {
      return createRequire(base)('viem/accounts');
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(
    'viem is not installed where web-dapp can see it (the app checkout, then adapter-web).\n' +
      'Next: install viem in the app checkout under test.',
  );
}
