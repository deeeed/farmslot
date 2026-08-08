import type { PairingAuthority, Role } from '@farmslot/protocol';

export type PairingAuthorityKind = PairingAuthority['kind'] | '';
export type PairingAuthorityRole = Role | '';

export function pairingAuthorityFromSelection(
  kind: PairingAuthorityKind,
  existingPrincipalId: string,
  newServiceName: string,
  role: PairingAuthorityRole,
): PairingAuthority {
  if (kind === 'existing-principal') {
    const principalId = existingPrincipalId.trim();
    if (!principalId) throw new Error('Enter the existing principal ID for Companion');
    return { kind, principalId };
  }
  if (kind === 'new-service-principal') {
    const displayName = newServiceName.trim();
    if (!displayName) throw new Error('Enter a new Companion service principal name');
    if (!role) throw new Error('Choose the new Companion service principal role');
    return { kind, displayName, roles: [{ role, scope: { kind: 'global' } }] };
  }
  throw new Error('Choose an explicit Companion pairing authority');
}
