import type { NativeAccountObservation } from '@farmslot/protocol';

export type { NativeAccountObservation } from '@farmslot/protocol';

export interface NativeAccountProbeOptions {
  /** Probe the actual runner execution context, including its native profile variables. */
  cwd: string;
  executable?: string;
  /** Complete effective profile environment. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
}

export type NativeAccountState = Pick<
  NativeAccountObservation,
  'login' | 'mode' | 'identity' | 'identityQuality' | 'reason'
>;
