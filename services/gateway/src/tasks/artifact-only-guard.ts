const ARTIFACT_ONLY_TASK_FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /gh\s+pr\s+create/gi, reason: 'forbidden GitHub PR creation command' },
  { pattern: /gh\s+pr\s+comment/gi, reason: 'forbidden GitHub PR comment command' },
  { pattern: /gh\s+pr\s+edit/gi, reason: 'forbidden GitHub PR edit command' },
  { pattern: /gh\s+pr\s+merge/gi, reason: 'forbidden GitHub PR merge command' },
  { pattern: /gh\s+pr\s+ready/gi, reason: 'forbidden GitHub PR ready command' },
  { pattern: /git\s+push\b/gi, reason: 'forbidden git push instruction' },
  { pattern: /commit\s+(?:and|&)\s+push/gi, reason: 'forbidden commit-and-push instruction' },
  { pattern: /push\s+(?:and|&)\s+create/gi, reason: 'forbidden push-and-create instruction' },
  { pattern: /publish\s+(?:the\s+)?branch/gi, reason: 'forbidden branch publication instruction' },
  { pattern: /create\s+(?:a\s+)?(?:draft\s+)?pr\b/gi, reason: 'forbidden PR creation instruction' },
  {
    pattern: /create\s+(?:a\s+)?(?:draft\s+)?pull\s+request\b/gi,
    reason: 'forbidden PR creation instruction',
  },
  { pattern: /draft\s+pr\b/gi, reason: 'forbidden draft PR instruction' },
  { pattern: /mark\s+ready\b/gi, reason: 'forbidden merge-intended ready instruction' },
  { pattern: /ready[-\s]+for[-\s]+review/gi, reason: 'forbidden ready-for-review instruction' },
  { pattern: /merge-intended\s+pr/gi, reason: 'forbidden merge-intended PR wording' },
  { pattern: /open\s+(?:a\s+)?pr\b(?!-)/gi, reason: 'forbidden open-PR instruction' },
  { pattern: /open\s+(?:a\s+)?pull\s+request\b/gi, reason: 'forbidden open-PR instruction' },
];

const ARTIFACT_ONLY_TASK_DIRECT_NEGATION_PATTERN =
  /\b(?:do not|don't|never|must not)\b(?!\s+forget\b)(?:(?![.;!?]).){0,96}$/iu;
const ARTIFACT_ONLY_TASK_FORBIDDEN_WORD_NEGATION_PATTERN = /\b(?:forbid|forbidden)\s+$/i;
const ARTIFACT_ONLY_TASK_CLAUSE_BOUNDARY = /^(?:.*,\s*|.*\b(?:then|and|but)\b\s*)/iu;
const ARTIFACT_ONLY_TASK_NEGATION_REVERSAL_PATTERN = /^\s*(?:[,;:—–-]\s*)?(?:unless|except)\b/iu;

export interface ArtifactOnlyTaskGuardResult {
  allowed: boolean;
  reason?: string;
}

export function evaluateArtifactOnlyTaskGuard(markdown: string): ArtifactOnlyTaskGuardResult {
  for (const line of markdown.split('\n')) {
    const normalized = line.trim();
    for (const rule of ARTIFACT_ONLY_TASK_FORBIDDEN_PATTERNS) {
      const pattern = rule.pattern;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(normalized)) !== null) {
        if (match[0].length === 0) pattern.lastIndex += 1;
        const currentClauseSuffix = normalized.slice(match.index + match[0].length);
        const currentClausePrefix = normalized
          .slice(0, match.index)
          .replace(/^.*[.;!?]\s*/u, '')
          .replace(ARTIFACT_ONLY_TASK_CLAUSE_BOUNDARY, '');
        const negated =
          ARTIFACT_ONLY_TASK_DIRECT_NEGATION_PATTERN.test(currentClausePrefix) ||
          ARTIFACT_ONLY_TASK_FORBIDDEN_WORD_NEGATION_PATTERN.test(currentClausePrefix);
        if (negated && !ARTIFACT_ONLY_TASK_NEGATION_REVERSAL_PATTERN.test(currentClauseSuffix))
          continue;
        return { allowed: false, reason: rule.reason };
      }
    }
  }
  return { allowed: true };
}

export function assertArtifactOnlyTaskGuard(markdown: string): void {
  const result = evaluateArtifactOnlyTaskGuard(markdown);
  if (!result.allowed) {
    throw new Error(
      `Artifact-only task guard failed: ${result.reason ?? 'forbidden publication instruction'}`,
    );
  }
}
