import type { ResolvedGatewayAuth } from './auth.js';
import type { CredentialStoreWriter } from './credential-store-writer.js';
import type { PrincipalResolver } from './principal-resolver.js';

export interface EnvironmentMigrationReport {
  created: boolean;
  credentialId?: string;
  otherActiveCredentialIds: string[];
}

export function reconcileEnvironmentCredential(params: {
  auth: ResolvedGatewayAuth;
  writer: CredentialStoreWriter;
  resolver: PrincipalResolver;
  log?: (message: string) => void;
}): EnvironmentMigrationReport {
  const configured = configuredSecret(params.auth);
  if (!configured) {
    params.resolver.setBootCredential(undefined);
    return { created: false, otherActiveCredentialIds: [] };
  }
  const result = params.writer.reconcileEnvironmentCredential(configured.rawSecret);
  params.resolver.setBootCredential({
    rawSecret: configured.rawSecret,
    credentialId: result.credentialId,
    transport: configured.transport,
  });
  if (result.created || result.otherActiveCredentialIds.length > 0) {
    const prefix = result.created
      ? `${configured.variable} does not match any active credential; migrated it as a new one.\n`
      : '';
    const other = result.otherActiveCredentialIds.length
      ? `${result.otherActiveCredentialIds.length} other active env-migrated credential does not match this environment — changing or unsetting the variable does not remove access.\n` +
        'Next: to remove it, run\n' +
        `  farmslot credential revoke ${result.otherActiveCredentialIds[0]}\n` +
        'or stop every gateway and revoke offline.'
      : '';
    params.log?.(`${prefix}${other}`.trim());
  }
  return {
    created: result.created,
    credentialId: result.credentialId,
    otherActiveCredentialIds: result.otherActiveCredentialIds,
  };
}

function configuredSecret(auth: ResolvedGatewayAuth):
  | {
      rawSecret: string;
      transport: 'token' | 'password';
      variable: 'FARMSLOT_GATEWAY_TOKEN' | 'FARMSLOT_GATEWAY_PASSWORD';
    }
  | undefined {
  if (auth.mode === 'password' && auth.password) {
    return {
      rawSecret: auth.password,
      transport: 'password',
      variable: 'FARMSLOT_GATEWAY_PASSWORD',
    };
  }
  if (auth.mode === 'token' && auth.token) {
    return {
      rawSecret: auth.token,
      transport: 'token',
      variable: 'FARMSLOT_GATEWAY_TOKEN',
    };
  }
  return undefined;
}
