// The venue policy of the adapter that extends web-dapp (e.g. the Terminal
// plugin's plugins/terminal/policy.mjs): what web-dapp's launch, wallet host,
// readiness and actions know about the app's venue. mm-harness sets its module
// path in RECIPE_WEB_DAPP_POLICY when it binds such an adapter, so every
// web-dapp leaf process and live action it starts reads the same policy.

import { createRequire } from 'node:module';
import path from 'node:path';

import { assertPolicyDigest, POLICY_DIGEST_ENV } from './policy-fence.mjs';

export const POLICY_ENV = 'RECIPE_WEB_DAPP_POLICY';
// The policy contract this web-dapp reads; a policy declares the version it was written for.
export const POLICY_VERSION = 1;
let loaded;

// Every member web-dapp reads, checked once when the policy loads: a missing or mistyped
// member fails here, naming the module, instead of deep in a launch or an assertion (a
// missing signatureLog would silently drop the venue's L1 and mainnet rules).
const MEMBERS = {
  adapterId: 'string',
  checkout: 'object',
  venueHosts: 'function',
  linkHosts: 'array',
  probe: 'object',
  startChain: 'number',
  refuseTypedData: 'object',
  signatureLog: 'object',
  startPath: 'string',
  pagePath: 'function',
  dependencies: 'array',
  testnetVariable: 'string',
  module: 'string',
};

function checkPolicy(policy, file) {
  const problems = [];
  if (!policy || typeof policy !== 'object') problems.push('exports no policy object');
  else {
    if (policy.policyVersion !== POLICY_VERSION)
      problems.push(
        `policyVersion is ${policy.policyVersion ?? 'missing'}, this web-dapp reads ${POLICY_VERSION}`,
      );
    for (const [name, type] of Object.entries(MEMBERS)) {
      const value = policy[name];
      const ok =
        type === 'array'
          ? Array.isArray(value)
          : type === 'object'
            ? value !== null && typeof value === 'object'
            : typeof value === type;
      if (!ok)
        problems.push(
          `${name} must be ${type === 'array' || type === 'object' ? `an ${type}` : `a ${type}`}`,
        );
    }
    const { checkout, refuseTypedData, signatureLog } = policy;
    if (checkout && typeof checkout.matches !== 'function')
      problems.push('checkout.matches must be a function');
    for (const name of ['name', 'label', 'needs'])
      if (checkout && typeof checkout[name] !== 'string')
        problems.push(`checkout.${name} must be a string`);
    if (refuseTypedData && typeof refuseTypedData.reason !== 'function')
      problems.push('refuseTypedData.reason must be a function');
    for (const name of ['kind', 'message'])
      if (refuseTypedData && typeof refuseTypedData[name] !== 'string')
        problems.push(`refuseTypedData.${name} must be a string`);
    // The venue's request-log rules: both maps are required (empty only on purpose), so a
    // policy cannot drop its L1 or mainnet rules by omission.
    for (const name of ['typedDataClasses', 'forbiddenEntries']) {
      if (signatureLog && (signatureLog[name] === null || typeof signatureLog[name] !== 'object'))
        problems.push(`signatureLog.${name} must be an object`);
    }
  }
  if (problems.length) {
    throw new Error(
      `web-dapp venue policy ${file}: ${problems.join('; ')}.\nNext: update the library that declares the adapter to a revision written for this mm-harness.`,
    );
  }
  return policy;
}

export function webDappPolicy(env = process.env) {
  const file = env[POLICY_ENV];
  if (!file) {
    throw new Error(
      'web-dapp needs a venue policy: select an adapter that extends it.\n' +
        'Next: put the library that declares it on RECIPE_LIBRARY_PATH and pass its id, e.g. --adapter terminal.',
    );
  }
  const digest = env[POLICY_DIGEST_ENV];
  if (loaded?.file !== file || loaded.digest !== digest) {
    // The digest mm-harness took when it bound the policy: refuse files that changed since.
    if (digest) assertPolicyDigest(file, digest);
    // The policy module uses node built-ins only and has no top-level await, so it loads synchronously.
    loaded = {
      file,
      digest,
      policy: checkPolicy(createRequire(import.meta.url)(path.resolve(file)).policy, file),
    };
  }
  return loaded.policy;
}

// The bound adapter's id, for names and paths; web-dapp's own when none is bound.
export function webDappAdapterId(env = process.env) {
  return env[POLICY_ENV] ? webDappPolicy(env).adapterId : 'web-dapp';
}
