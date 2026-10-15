export interface DiffScopeCandidate {
  file: string;
  category: string;
}

export const REVIEW_DIFF_SCOPE_RULE: string;
export function diffScopeCandidates(files: readonly string[]): DiffScopeCandidate[];
export function buildDiffScopePacket(files: readonly string[], unavailable?: string): string;
export function gitDiffScopeFiles(repo: string, base: string, head: string): string[];
