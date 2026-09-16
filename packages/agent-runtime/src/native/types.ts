import type {
  NativeSessionCapabilities,
  NativeSessionEvent,
  NativeSessionResponse,
  SafetyTier,
} from '@farmslot/protocol';

import type { NativeProcessSandbox } from './review-sandbox.js';
import type { NativeWorkerFilesystemPolicy } from './worker-launch.js';

export type NativeEventInput = Omit<
  NativeSessionEvent,
  'sequence' | 'at' | 'sessionId' | 'generation'
>;
export interface NativeAdapterOptions {
  cwd: string;
  onSpawn?: (pid: number, identity: string) => void;
  signal?: AbortSignal;
  executable: string;
  model?: string;
  mode?: 'default' | 'plan';
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  effort?: string;
  safetyTier?: SafetyTier;
  filesystemPolicy?: NativeWorkerFilesystemPolicy;
  processSandbox?: NativeProcessSandbox;
}
export interface NativeAdapterSession {
  nativeSessionId: string;
  capabilities?: NativeSessionCapabilities;
  send(text: string, commandId: string): Promise<void>;
  respond(requestId: string, response: NativeSessionResponse): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export interface NativeAdapter {
  capabilities: NativeSessionCapabilities;
  /** A missing capability is unsupported, never a request for advisory prompt restrictions. */
  filesystemPolicyUnavailableReason?: (version: string) => string | undefined;
  /** Compatibility policy based on the native executable's version metadata. */
  workspaceResumeUnavailableReason?: (version: string) => string | undefined;
  resumeUnavailableReason?: (version: string) => string | undefined;
  start(
    options: NativeAdapterOptions,
    emit: (event: NativeEventInput) => void,
  ): Promise<NativeAdapterSession>;
}
