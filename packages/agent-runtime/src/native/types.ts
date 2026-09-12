import type {
  NativeSessionCapabilities,
  NativeSessionEvent,
  NativeSessionResponse,
} from '@farmslot/protocol';

export type NativeEventInput = Omit<
  NativeSessionEvent,
  'sequence' | 'at' | 'sessionId' | 'generation'
>;
export interface NativeAdapterOptions {
  cwd: string;
  onSpawn?: (pid: number, identity: string) => void;
  executable: string;
  model?: string;
  mode?: 'default' | 'plan';
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
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
  start(
    options: NativeAdapterOptions,
    emit: (event: NativeEventInput) => void,
  ): Promise<NativeAdapterSession>;
}
