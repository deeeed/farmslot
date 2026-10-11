export type RecoveryBranchPresence = 'local' | 'published' | 'missing' | 'unknown';
export type RecoveryBranchAction = 'preserve' | 'fresh';

export interface RecoveryBranchState {
  branch: string;
  presence: RecoveryBranchPresence;
  workerNeverStarted: boolean;
  /** False also covers unreachable or dirty source work on a cross-slot recovery. */
  sourceWorkSafe: boolean;
}

/** The entry step and when the name was assigned cannot authorize losing work. */
export function recoveryBranchAction(state: RecoveryBranchState): RecoveryBranchAction {
  if (!state.sourceWorkSafe)
    throw new Error(
      `Replay cannot preserve ${state.branch}: original work has unpushed commits, dirty files or could not be verified. Push or preserve it before changing slots; no branch was reset or deleted.`,
    );
  if (state.presence === 'local' || state.presence === 'published') return 'preserve';
  if (state.presence === 'unknown')
    throw new Error(
      `Replay cannot initialize ${state.branch}: remote absence is unconfirmed. Restore access to the remote before retrying; no branch was reset or deleted.`,
    );
  if (state.workerNeverStarted) return 'fresh';
  throw new Error(
    `Replay cannot preserve ${state.branch}: no local or published branch and the worker may have started. Restore or push the run branch before retrying; no branch was reset or deleted.`,
  );
}
