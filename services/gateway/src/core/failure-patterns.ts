import type { FailureCategory, RunRecoveryProposalConfidence } from '@farmslot/protocol';
export interface FailurePatternMatch {
  patternId: string;
  category: FailureCategory;
  confidence: RunRecoveryProposalConfidence;
  matchedText: string;
}
interface FailurePattern {
  id: string;
  category: FailureCategory;
  confidence: RunRecoveryProposalConfidence;
  re: RegExp;
}
const PATTERNS: FailurePattern[] = [
  {
    id: 'devserver-crashed',
    category: 'infra',
    confidence: 'high',
    re: /(?:ECONNREFUSED|connection refused|dev\s*server.*(?:down|crash|killed)|vite.*not responding|webpack.*not responding|fixture sync failed)/i,
  },
  {
    id: 'network-timeout',
    category: 'timeout',
    confidence: 'high',
    re: /(?:timed? out|timeout|ETIMEDOUT|operation timed out)/i,
  },
  {
    id: 'transient-network',
    category: 'infra',
    confidence: 'medium',
    re: /(?:EAI_AGAIN|ENOTFOUND|network.*(?:reset|unreachable)|socket hang up|ECONNRESET)/i,
  },
  {
    id: 'fixture-env-drift',
    category: 'env-drift',
    confidence: 'high',
    re: /(?:fixture.*(?:missing|mismatch|out of sync)|env(?:ironment)? drift|AGENTS\.md.*not uptodate|Entry .* not uptodate)/i,
  },
  {
    id: 'flaky-test',
    category: 'flake',
    confidence: 'medium',
    re: /(?:flaky|intermittent|race condition|detox.*flak|locator.*strict mode violation)/i,
  },
];
export function classifyFailureText(
  text: string,
  disabledPatterns: readonly string[] = [],
): FailurePatternMatch | null {
  const disabled = new Set(disabledPatterns);
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    return {
      patternId: pattern.id,
      category: pattern.category,
      confidence: disabled.has(pattern.id) ? 'low' : pattern.confidence,
      matchedText: match[0],
    };
  }
  return null;
}
export const KNOWN_REAL_BUG_NEGATIVE_CORPUS = [
  'TypeError: Cannot read properties of undefined (reading balance)',
  'AssertionError: expected 3 to equal 4 in business logic reducer',
  'SyntaxError: Unexpected token in src/components/widget.ts',
  'ReferenceError: selectedAccount is not defined',
];
