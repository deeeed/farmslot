import type { DiffFileKind } from './diff-view.js';
export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  ignored?: boolean;
}

export type GitChangeStatus = 'M' | 'A' | 'D' | '?' | 'R';

export interface GitChange {
  path: string;
  status: GitChangeStatus;
  staged: boolean;
  oldPath?: string; // for renames
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// ─── Branch Diff ───

export type BranchDiffStatus = 'M' | 'A' | 'D' | 'R';

export interface GitBranchDiffFile {
  path: string;
  status: BranchDiffStatus;
  oldPath?: string; // for renames
  additions: number;
  deletions: number;
  /**
   * Worktree-target only: whether this file also has committed changes vs the
   * base (false = purely local). Undefined for head-target diffs, where every
   * listed file is committed by definition.
   */
  committed?: boolean;
  /** Test-file classification from the project's `diff_view` patterns (defaults apply). */
  kind?: DiffFileKind;
}

// ─── Diagnostics ───

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  code?: string;
  source?: string; // "tsc", "eslint", "sonarqube", etc.
}

// ─── Search ───

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}
