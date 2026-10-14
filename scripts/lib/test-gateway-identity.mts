// Disposable gateway proofs issue credentials in their own isolated home.
import { join } from 'node:path';

import { loadProfiles, saveProfiles } from '../../packages/cli/src/gateway-profiles.js';

import { CredentialStoreRuntime, CredentialStoreWriter } from '@farmslot/credential-store';

export function testGatewayIdentity(home: string, url?: string): string {
  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: home });
  const writer = new CredentialStoreWriter(runtime, true);
  const principal = writer.createPrincipal({ type: 'service', displayName: 'test-automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const issued = writer.issueCredential(principal.id, 'protocol-proof');
  if (url) testGatewayProfile(home, url, issued.secret);
  return issued.secret;
}

export function testGatewayProfile(home: string, url: string, token: string, name = 'proof'): void {
  const file = join(home, 'gateways.json');
  const profiles = loadProfiles(file);
  profiles.gateways[name] = { url, authMode: 'token', secret: token };
  profiles.active ??= name;
  saveProfiles(profiles, file);
}
