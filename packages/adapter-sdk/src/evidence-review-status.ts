import { isRecord, type RecordedEvidencePackageInput } from '@farmslot/protocol';

export interface EvidenceReviewIssue {
  message: string;
  /** Number of reader/validator messages represented by this issue. */
  count: number;
}

export interface EvidenceReviewPackageStatus {
  status: 'Valid' | 'Legacy' | 'Invalid';
  /** Red requires an identified current-contract package, never an unknown read. */
  tone: 'success' | 'info' | 'error';
  /** Relative to the run's artifacts, independent of media transport paths. */
  path: string;
  summary: string;
  action?: string;
  issues: readonly EvidenceReviewIssue[];
}

const requiredFiles = ['summary.json', 'trace.json', 'artifact-manifest.json'] as const;

/** Presentation only. Raw reader/validator failures continue to refuse measured proof. */
export function evidenceReviewPackageStatus(
  pkg: RecordedEvidencePackageInput | undefined,
  packagePath: string | undefined,
  messages: readonly string[],
): EvidenceReviewPackageStatus | null {
  if (!pkg && !messages.length) return null;
  const missingCore = pkg ? requiredFiles.filter((file) => !pkg.artifactPaths?.includes(file)) : [];
  const missing = [
    ...missingCore,
    ...(pkg?.recipe && !pkg.artifactPaths?.includes('recipe-resolution.json')
      ? ['recipe-resolution.json']
      : []),
  ];
  const grouped = new Map<string, EvidenceReviewIssue>();
  for (const message of messages) {
    const file = missing.find(
      (file) =>
        message === `Missing required Recipe v1 artifact ${file}.` ||
        message === `Recipe artifact package must include ${file}.` ||
        message.startsWith(`${file} must be `),
    );
    const label = file ? `Missing ${file}` : message;
    const issue = grouped.get(label);
    if (issue) issue.count++;
    else grouped.set(label, { message: label, count: 1 });
  }
  const current = Boolean(
    (isRecord(pkg?.summary) && pkg.summary.version === 1) ||
    (isRecord(pkg?.manifest) && pkg.manifest.version === 1) ||
    (isRecord(pkg?.invocation) && pkg.invocation.version === 1) ||
    pkg?.claims?.schemaVersion === 2 ||
    (isRecord(pkg?.summary) && pkg.summary.recipeRunId) ||
    pkg?.artifactPaths?.includes('recipe-invocation.json'),
  );
  const legacy = Boolean(pkg && !current);
  const status = legacy ? 'Legacy' : messages.length ? 'Invalid' : 'Valid';
  return {
    status,
    tone: status === 'Invalid' && current ? 'error' : status === 'Valid' ? 'success' : 'info',
    path: (packagePath ?? '.').replace(/^artifacts\//u, '').replace(/\/$/u, '') || '.',
    summary: legacy
      ? `Recorded before Recipe v1: not machine-checkable${missing.length ? ` (missing ${missing.join(', ')})` : ''}; media untimed`
      : status === 'Invalid'
        ? `${grouped.size} evidence issue${grouped.size === 1 ? '' : 's'}; measured proof unavailable`
        : 'Recipe evidence is machine-checkable',
    ...(status === 'Invalid' && current
      ? { action: 'Refresh the gate package or re-run the recipe.' }
      : {}),
    issues: [...grouped.values()],
  };
}
