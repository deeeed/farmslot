import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

import type { NativeSessionCreateParams, NativeSessionInfo, SafetyTier } from '@farmslot/protocol';

/** Private gateway/node/host contract. Public session RPCs never accept this environment. */
export interface NativeWorkerLaunch {
  leaseId: string;
  executable?: string;
  accountLabel?: string;
  environment: { set: Record<string, string>; unset: string[] };
  effort?: string;
  safetyTier: SafetyTier;
  filesystemPolicy?: NativeWorkerFilesystemPolicy;
}

/** Source stays readable; tools may write only the separate task/output roots. */
export interface NativeWorkerFilesystemPolicy {
  readOnlyRoots: string[];
  writableRoots: string[];
}

export function validateNativeWorkerFilesystemPolicy(value: unknown): NativeWorkerFilesystemPolicy {
  const policy = object(value);
  if (Object.keys(policy).some((key) => !['readOnlyRoots', 'writableRoots'].includes(key)))
    throw new Error('Unsupported native worker filesystem policy field');
  for (const name of ['readOnlyRoots', 'writableRoots'] as const) {
    const roots = policy[name];
    if (
      !Array.isArray(roots) ||
      !roots.length ||
      roots.some((root) => typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'))
    )
      throw new Error('Native worker filesystem roots must be nonempty absolute paths');
  }
  const result = policy as unknown as NativeWorkerFilesystemPolicy;
  const within = (root: string, file: string) => {
    const child = relative(root, file);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  };
  if (
    result.readOnlyRoots.some((source) =>
      result.writableRoots.some((output) => within(source, output) || within(output, source)),
    )
  )
    throw new Error('Native worker source and writable roots must not overlap');
  return result;
}

export const NATIVE_WORKER_STATE = 'native.worker.state';
export const NATIVE_WORKER_ENSURE = 'native.worker.ensure';
export const NATIVE_WORKER_RESUME = 'native.worker.resume';
export const NATIVE_WORKER_SEND = 'native.worker.send';
export const NATIVE_WORKER_RESPOND = 'native.worker.respond';
export const NATIVE_WORKER_CLOSE = 'native.worker.close';
export const NATIVE_WORKER_INTERRUPT = 'native.worker.interrupt';
export const NATIVE_WORKER_TRANSFER = 'native.worker.transfer';
export const NATIVE_WORKER_CANCEL = 'native.worker.cancel';
export const NATIVE_WORKER_READ = 'native.worker.read';
export const NATIVE_WORKER_METHODS: readonly string[] = [
  NATIVE_WORKER_READ,
  NATIVE_WORKER_STATE,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_RESPOND,
  NATIVE_WORKER_CLOSE,
  NATIVE_WORKER_INTERRUPT,
  NATIVE_WORKER_TRANSFER,
  NATIVE_WORKER_CANCEL,
];

export interface NativeWorkerTarget {
  sessionId: string;
  executionNodeId?: string;
  generation: string;
  leaseId: string;
}
export interface NativeWorkerCancelTarget extends Omit<NativeWorkerTarget, 'generation'> {
  generation?: string;
  /** Cancelling a reserved successor may still find the source lease on the host. */
  sourceLeaseId?: string;
  /** Fence this durable recovery operation even if its launch has not reached the host. */
  resumeCommandId?: string;
}
export type NativeWorkerCancelResult = {
  sessionId: string;
  leaseId: string;
  generation?: string;
} & (
  | { cancelled: true; session?: NativeSessionInfo }
  | { cancelled: false; reason: 'generation-changed'; generation: string; session?: undefined }
);

export interface NativeWorkerResumeParams extends NativeSessionCreateParams {
  sessionId: string;
  resumeSessionId: string;
  generation: string;
  commandId: string;
  /** Explicit same-host parking relocation, fenced by the old generation and saved launch digest. */
  relocation?: { fromCwd: string };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native worker launch object');
  return value as Record<string, unknown>;
}

export function decodeNativeWorkerLaunch(value: unknown): NativeWorkerLaunch {
  const launch = object(value);
  if (
    Object.keys(launch).some(
      (key) =>
        ![
          'leaseId',
          'executable',
          'accountLabel',
          'environment',
          'effort',
          'safetyTier',
          'filesystemPolicy',
        ].includes(key),
    )
  )
    throw new Error('Unsupported native worker launch field');
  if (!['sandboxed', 'full-auto', 'dangerous'].includes(String(launch.safetyTier)))
    throw new Error('Invalid native worker safety tier');
  if (
    typeof launch.leaseId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(launch.leaseId)
  )
    throw new Error('Native worker leaseId must be a lowercase UUID');
  for (const key of ['executable', 'accountLabel', 'effort'] as const)
    if (launch[key] !== undefined && (typeof launch[key] !== 'string' || !launch[key].trim()))
      throw new Error(`Invalid native worker ${key}`);
  if (typeof launch.effort === 'string' && !/^[a-z][a-z0-9_-]*$/.test(launch.effort))
    throw new Error('Invalid native worker effort');
  const environment = object(launch.environment);
  if (Object.keys(environment).some((key) => !['set', 'unset'].includes(key)))
    throw new Error('Unsupported native worker environment field');
  const set = object(environment.set);
  const unset = environment.unset;
  const validName = (name: unknown): name is string =>
    typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  if (
    !Array.isArray(unset) ||
    !unset.every(validName) ||
    !Object.keys(set).every(validName) ||
    !Object.values(set).every((item) => typeof item === 'string' && !item.includes('\0'))
  )
    throw new Error('Invalid native worker environment mutation');
  return {
    leaseId: launch.leaseId,
    ...(typeof launch.executable === 'string' ? { executable: launch.executable } : {}),
    ...(typeof launch.accountLabel === 'string' ? { accountLabel: launch.accountLabel } : {}),
    ...(typeof launch.effort === 'string' ? { effort: launch.effort } : {}),
    safetyTier: launch.safetyTier as SafetyTier,
    ...(launch.filesystemPolicy === undefined
      ? {}
      : {
          filesystemPolicy: validateNativeWorkerFilesystemPolicy(launch.filesystemPolicy),
        }),
    environment: { set: set as Record<string, string>, unset },
  };
}

/** Journals compare launch settings without retaining project environment values. */
export function nativeWorkerLaunchDigest(launch: NativeWorkerLaunch): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        executable: launch.executable,
        accountLabel: launch.accountLabel,
        safetyTier: launch.safetyTier,
        effort: launch.effort,
        ...(launch.filesystemPolicy ? { filesystemPolicy: launch.filesystemPolicy } : {}),
        environment: {
          set: Object.entries(launch.environment.set).sort(([a], [b]) => a.localeCompare(b)),
          unset: [...new Set(launch.environment.unset)].sort(),
        },
      }),
    )
    .digest('hex');
}

export function nativeWorkerEnvironment(launch: NativeWorkerLaunch): NodeJS.ProcessEnv {
  const unset = new Set(launch.environment.unset);
  // Object.fromEntries treats names as data, including names matching Object.prototype keys.
  const env = Object.fromEntries([
    ...Object.entries(process.env).filter(([key]) => !unset.has(key)),
    ...Object.entries(launch.environment.set),
  ]);
  env.DISABLE_OMC = '1';
  env.DISABLE_OMX = '1';
  const shims = join(env.ASDF_DATA_DIR ?? join(env.HOME ?? homedir(), '.asdf'), 'shims');
  if (existsSync(shims)) env.PATH = `${shims}${delimiter}${env.PATH ?? ''}`;
  delete env.CLAUDECODE;
  // Workers do not need control-plane credentials, including configured overrides.
  delete env.FARMSLOT_NODE_TOKEN;
  delete env.FARMSLOT_GATEWAY_TOKEN;
  delete env.FARMSLOT_GATEWAY_PASSWORD;
  return env;
}
