import type { SafetyTier } from '../contracts/agents.js';

import { Methods } from './registry.js';
import type { TmuxWorkerRef } from './tmux.js';

export const CopilotRuntimeMethods = {
  status: Methods.COPILOT_STATUS,
  configure: Methods.COPILOT_CONFIGURE,
  start: Methods.COPILOT_START,
  stop: Methods.COPILOT_STOP,
} as const;

export const COPILOT_TMUX_SESSION = 'farmslot-copilot';
export const COPILOT_TMUX_WINDOW_NAME = 'agent';
export const COPILOT_TMUX_WINDOW_INDEX = '0';
export const COPILOT_TMUX_TARGET = `${COPILOT_TMUX_SESSION}:${COPILOT_TMUX_WINDOW_NAME}.0` as const;

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
  /** Authoritative terminal identity for clients; avoids rediscovering the singleton via inventory. */
  terminalWorker?: TmuxWorkerRef;
  transcriptId: string;
  runner: string;
  model: string;
  autostart: boolean;
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

export interface CopilotConfigureParams {
  runner?: string;
  model?: string;
  autostart?: boolean;
}

export interface CopilotConfigureResult {
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
