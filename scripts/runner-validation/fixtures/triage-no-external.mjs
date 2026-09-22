// Owned validation processes only. Do not use as a general network sandbox.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
assert.ok(process.env.TRIAGE_NETWORK_GUARD);
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const address = new URL(typeof url === 'string' ? url : (url.url ?? url.href));
  if (address.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(address.hostname))
    return nativeFetch(url, options);
  const file = process.env.TRIAGE_NETWORK_GUARD;
  writeFileSync(file, String(Number(readFileSync(file, 'utf8')) + 1));
  throw new Error('External fetch blocked by stale-price proof');
};
