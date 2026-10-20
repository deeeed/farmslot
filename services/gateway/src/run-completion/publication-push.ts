import type { ExecResult } from '../core/exec.js';

/** The push runs the repository's pre-push hook: MetaMask/core's `yarn lint` takes ~3 minutes. */
export const PUBLICATION_PUSH_TIMEOUT_MS = 600_000;

/**
 * A refused push (the repository's pre-push hook, or the remote) leaves no branch to open a
 * PR from, and GitHub would then report only a blank head. Stop publication with its error.
 */
export function assertPublicationBranchPushed(
  push: ExecResult,
  branch: string,
  runId: string,
): void {
  if (push.exitCode === 0) return;
  // A hook prints its findings on stdout, ahead of its closing hints: keep them in the log.
  console.warn(
    `[run-completion] run ${runId.slice(0, 8)} — git push output: ${push.stdout.slice(-20_000)}`,
  );
  throw new Error(
    `git push of ${branch} failed (exit ${push.exitCode}); the repository's pre-push hook, the remote or the push timeout stopped it (hook output is in the gateway log): ${push.stderr.trim().slice(-1500) || 'no error output'}`,
  );
}
