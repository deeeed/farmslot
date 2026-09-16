import { createRequire } from 'node:module';

import type { NativeWorkerFilesystemPolicy } from './worker-launch.js';

export interface NativeProcessSandbox {
  executable: string;
  args: string[];
}
const implementation = createRequire(import.meta.url)('../../scripts/review-filesystem.cjs') as {
  available(): boolean;
  sandbox(
    policy: NativeWorkerFilesystemPolicy,
    runtimeRoots: string[],
  ): Promise<{ sandbox: NativeProcessSandbox; temporaryDirectory: string }>;
};
export const hostReviewSandboxAvailable = implementation.available;
/** Shared with terminal review launches; trust settings cannot weaken source protection. */
export const reviewProcessSandbox = implementation.sandbox;
