export interface Principal {
  id: string;
  subject: PrincipalSubject;
  roles: RoleBinding[];
}

export type PrincipalSubject =
  | { type: 'person'; displayName: string }
  | { type: 'service'; displayName: string }
  | { type: 'node'; displayName: string; machine: string };

export interface RoleBinding {
  role: Role;
  scope: RoleScope;
}

export type Role = 'admin' | 'operator';
export type RoleScope = { kind: 'global' };

/** Opaque session authentication reference. Authority is always resolved live. */
export type AuthenticationRef = { kind: 'credential'; credentialId: string };

/** The authenticated caller only. Never describes another principal. */
export interface SelfPrincipalSummary {
  id: string;
  displayName: string;
  subjectKind: PrincipalSubject['type'];
  roles: RoleBinding[];
}

export interface CredentialSummary {
  id: string;
  principalId: string;
  displayName: string;
  origin: 'issued' | 'paired' | 'env-migrated';
  createdAt: string;
  revokedAt: string | null;
}

export interface PrincipalCreateParams {
  subject: PrincipalSubject;
  roles: RoleBinding[];
}
export interface PrincipalCreateResult {
  principal: Principal;
}
export interface PrincipalListParams {}
export interface PrincipalListResult {
  principals: Principal[];
}
export interface PrincipalGrantParams {
  principalId: string;
  role: Role;
  scope: RoleScope;
}
export interface PrincipalGrantResult {
  principal: Principal;
}
export interface PrincipalRevokeRoleParams extends PrincipalGrantParams {}
export interface PrincipalRevokeRoleResult {
  principal: Principal;
}
export interface CredentialIssueParams {
  principalId: string;
  displayName: string;
}
export interface CredentialIssueResult {
  credential: CredentialSummary;
  secret: string;
  adminGrant?: { credential: CredentialSummary; secret: string };
  activationLatched?: boolean;
}
export interface CredentialListParams {
  includeRevoked?: boolean;
}
export interface CredentialListResult {
  credentials: CredentialSummary[];
}
export interface CredentialRevokeParams {
  credentialId: string;
}
export interface CredentialRevokeResult {
  credential: CredentialSummary;
}
