import { Methods } from './registry.js';

export const AuthMethods = {
  connect: Methods.AUTH_CONNECT,
} as const;

export type GatewayAuthClientKind = 'ui' | 'companion' | 'node';
export type GatewayAuthMode = 'none' | 'token' | 'password';

export interface GatewayAuthConnectParams {
  clientKind: GatewayAuthClientKind;
  token?: string;
  password?: string;
  clientName?: string;
  protocolVersion?: string;
}

export interface GatewayAuthConnectResult {
  ok: true;
  clientKind: GatewayAuthClientKind;
  authMode: GatewayAuthMode;
  authenticatedAt: number;
  capabilities: {
    httpBearerAuth: boolean;
    voiceInstructionFormatting: boolean;
    /** Absent on gateways predating the lightweight liveness method. */
    gatewayPing?: boolean;
  };
}

export interface PairingCreateParams {
  gatewayUrl: string;
  profileName?: string;
  ttlSeconds?: number;
}

export interface PairingCreateResult {
  url: string;
  code: string;
  profileName: string;
  expiresAt: string;
}

export interface PairingCandidatesParams {
  port?: number;
}

export interface PairingCandidate {
  gatewayUrl: string;
  profileName: string;
  kind: 'lan' | 'tailnet';
}

export interface PairingCandidatesResult {
  candidates: PairingCandidate[];
}

export interface PairingExchangeParams {
  code: string;
}

export interface PairingExchangeResult {
  profile: {
    name: string;
    url: string;
    authMode: Exclude<GatewayAuthMode, 'none'>;
    secret: string;
  };
  expiresAt: string;
}
