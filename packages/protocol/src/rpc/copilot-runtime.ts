import type { SafetyTier } from '../contracts/agents.js';

import { Methods } from './registry.js';

export const CopilotRuntimeMethods = {
  status: Methods.COPILOT_STATUS,
  start: Methods.COPILOT_START,
  stop: Methods.COPILOT_STOP,
} as const;

export type CopilotRuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'reconnecting'
  | 'stopping'
  | 'failed'
  | 'ambiguous';

export type CopilotDeliveryState = 'idle' | 'accepted' | 'deferred' | 'failed';

export interface CopilotDelivery {
  id: string;
  state: CopilotDeliveryState;
  messageId?: string;
  requestedAt: string;
  settledAt?: string;
  reason?: string;
}

export interface CopilotCheckoutIdentity {
  path: string;
  branch: string;
  head: string;
  dirtyFileCount: number;
  dirtyPaths: string[];
}

export interface CopilotWorkloadTotals {
  implementation: number;
  independentReview: number;
  reviewRework: number;
  ciFix: number;
  fullQa: number;
  recipe: number;
  prepare: number;
  devServer: number;
  copilot: number;
  total: number;
}

export interface CopilotHostWorkload extends CopilotWorkloadTotals {
  host: string;
}

export interface CopilotWorkloadSnapshot {
  severity: 'normal' | 'high';
  warning?: string;
  totals: CopilotWorkloadTotals;
  hosts: CopilotHostWorkload[];
  policy: {
    singleton: true;
    automaticCancellation: false;
    automaticDispatch: false;
    automaticFanOut: false;
  };
}

export interface CopilotDangerousLaunchBinding {
  fingerprint: string;
  typedPhrase: string;
  warning: string;
  checkout: string;
  branch: string;
  head: string;
  dirtyFileCount: number;
  runner: string;
  model: string;
  safetyTier: 'dangerous';
}

export interface CopilotDangerousConfirmation {
  fingerprint: string;
  typedPhrase: string;
  warningAcknowledged: true;
}

export interface CopilotRuntimeSession {
  runtimeId: string;
  status: CopilotRuntimeStatus;
  tmuxTarget: string;
  transcriptId: string;
  runner: string;
  model: string;
  safetyTier: SafetyTier;
  checkout: CopilotCheckoutIdentity;
  workload: CopilotWorkloadSnapshot;
  lastDelivery: CopilotDelivery;
  createdAt?: string;
  startedAt?: string;
  reconnectedAt?: string;
  updatedAt: string;
  stoppedAt?: string;
  terminalReason?: string;
  dangerousLaunch: CopilotDangerousLaunchBinding;
}

export interface CopilotStatusParams {}

export interface CopilotStatusResult {
  session: CopilotRuntimeSession;
}

export interface CopilotStartParams {
  mode?: 'start' | 'reconnect';
  runner?: string;
  model?: string;
  safetyTier?: SafetyTier;
  confirmation?: CopilotDangerousConfirmation;
}

export interface CopilotStartResult {
  session: CopilotRuntimeSession;
  reused: boolean;
  reconnected: boolean;
}

export interface CopilotStopParams {
  reason?: string;
}

export interface CopilotStopResult {
  ok: true;
  session: CopilotRuntimeSession;
}

export interface CopilotRuntimeUpdatedPayload {
  session: CopilotRuntimeSession;
}
