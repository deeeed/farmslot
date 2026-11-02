import { createRequire } from 'node:module';

import type { NativeWorkerFilesystemPolicy } from './worker-launch.js';

/** Inside the runtime roots, what a review may write: whole paths, or only the bytes of files. */
export interface NativeReviewRuntimeAccess {
  writablePaths?: string[];
  dataFiles?: string[];
  /** Files inside writable paths that keep their identity: writable, never removed or replaced. */
  fixedPaths?: string[];
}
export interface NativeProcessSandbox {
  executable: string;
  args: string[];
}
const implementation = createRequire(import.meta.url)('../../scripts/review-filesystem.cjs') as {
  available(): boolean;
  sandbox(
    policy: NativeWorkerFilesystemPolicy,
    runtimeRoots: string[],
    configurationRoots?: string[],
    runtimeAccess?: NativeReviewRuntimeAccess,
  ): Promise<{ sandbox: NativeProcessSandbox; temporaryDirectory: string }>;
};
export const hostReviewSandboxAvailable = implementation.available;
/** Shared with terminal review launches; trust settings cannot weaken source protection. */
export const reviewProcessSandbox = implementation.sandbox;
