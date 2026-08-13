import type { GitChange, GitLogEntry } from '../contracts/index.js';

import type { SlotAgentTargetParams } from './terminal.js';

type TmuxTargetParams = Omit<SlotAgentTargetParams, 'runId'>;

export interface GitStatusParams {
  slotId: string;
}

export interface GitDiffParams {
  slotId: string;
  path?: string;
  /** Rename old side — included in the path limiter so renames diff correctly. */
  oldPath?: string;
  base?: string; // three-dot diff against merge-base when set
  /** Exact reviewed head SHA. When present, diff merge-base(base, head)..head instead of live HEAD. */
  head?: string;
  /**
   * With a base: 'head' (default) diffs merge-base..HEAD (committed only);
   * 'worktree' diffs merge-base against the working tree — every change on
   * the branch, committed or not.
   */
  target?: 'head' | 'worktree';
}

export interface GitLogParams {
  slotId: string;
  limit?: number;
}

export interface GitShowParams {
  slotId: string;
  ref: string;
  path: string;
}
export interface TmuxSplitParams extends TmuxTargetParams {
  direction: 'h' | 'v';
}

export interface TmuxSelectPaneParams extends TmuxTargetParams {
  direction: 'U' | 'D' | 'L' | 'R';
}

export interface TmuxKillPaneParams extends TmuxTargetParams {}

export interface TmuxZoomPaneParams extends TmuxTargetParams {}

export interface TmuxNewWindowParams extends TmuxTargetParams {}

export interface TmuxSelectWindowParams extends TmuxTargetParams {
  index: number;
}

export interface TmuxListParams extends TmuxTargetParams {}

export interface TmuxRenameWindowParams extends TmuxTargetParams {
  name: string;
}

export interface TmuxSendKeysParams extends TmuxTargetParams {
  keys: string;
}

export interface TmuxSynchronizePanesParams extends TmuxTargetParams {
  enabled: boolean;
}

export interface TmuxPane {
  index: number;
  active: boolean;
  width: number;
  height: number;
  title: string;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  synchronizePanes: boolean;
  panes: TmuxPane[];
}

export interface TmuxListResult {
  windows: TmuxWindow[];
}
export interface GitStageParams {
  slotId: string;
  path: string;
}

export interface GitUnstageParams {
  slotId: string;
  path: string;
}

export interface GitDiscardParams {
  slotId: string;
  path: string;
}
export interface GitStatusResult {
  branch: string;
  headSha: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export interface GitDiffResult {
  diff: string;
}

export interface GitLogResult {
  entries: GitLogEntry[];
}

export interface GitShowResult {
  content: string;
}

// ─── Branch diff param/result types ───

export interface GitBranchDiffParams {
  slotId: string;
  base?: string; // defaults to 'main'
  /** Exact reviewed head SHA. When present, list merge-base(base, head)..head instead of live HEAD. */
  head?: string;
  /**
   * 'head' (default) lists committed changes (merge-base..HEAD) — what a PR
   * would contain right now. 'worktree' lists every change vs the merge-base
   * including uncommitted and untracked files, deduped per file.
   */
  target?: 'head' | 'worktree';
}

export interface GitBranchDiffResult {
  base: string;
  head: string;
  files: import('../contracts/index.js').GitBranchDiffFile[];
  /** Line totals exclude untracked files (worktree target lists them with 0/0). */
  totalAdditions: number;
  totalDeletions: number;
}
