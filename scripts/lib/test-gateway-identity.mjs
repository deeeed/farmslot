// Disposable gateway proofs issue credentials in their own isolated home.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { register } from 'tsx/esm/api';

// Plain-node recipes and TSX proofs use the same source implementations.
const loader = register({
  namespace: 'test-gateway-identity',
  tsconfig: fileURLToPath(new URL('../../packages/cli/tsconfig.json', import.meta.url)),
});
let loadProfiles, saveProfiles, CredentialStoreRuntime, CredentialStoreWriter;
try {
  ({ loadProfiles, saveProfiles } = await loader.import(
    '../../packages/cli/src/gateway-profiles.ts',
    import.meta.url,
  ));
  ({ CredentialStoreRuntime, CredentialStoreWriter } = await loader.import(
    '@farmslot/credential-store',
    import.meta.url,
  ));
} finally {
  await loader.unregister();
}

/** @param {string} home @param {string} [url] */
export function testGatewayIdentity(home, url) {
  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: home });
  const writer = new CredentialStoreWriter(runtime, true);
  const principal = writer.createPrincipal({ type: 'service', displayName: 'test-automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const issued = writer.issueCredential(principal.id, 'protocol-proof');
  if (url) testGatewayProfile(home, url, issued.secret);
  return issued.secret;
}

/** @param {string} home @param {string} url @param {string} token */
export function testGatewayProfile(home, url, token, name = 'proof') {
  const file = join(home, 'gateways.json');
  const profiles = loadProfiles(file);
  profiles.gateways[name] = { url, authMode: 'token', secret: token };
  profiles.active ??= name;
  saveProfiles(profiles, file);
}
