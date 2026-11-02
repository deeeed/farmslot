import { isRecord, type RecordedEvidencePackageInput } from '@farmslot/protocol';

export interface EvidenceReviewIssue {
  message: string;
  /** Number of reader/validator messages represented by this issue. */
  count: number;
}

export interface EvidenceReviewPackageStatus {
  reasonCode?: 'evidence-package-unverifiable' | 'evidence-contract-unsupported';
  status: 'Valid' | 'Legacy' | 'Invalid' | 'Replaced';
  /** Red requires an identified current-contract package, never an unknown read. */
  tone: 'success' | 'info' | 'error';
  /** Relative to the run's artifacts, independent of media transport paths. */
  path: string;
  summary: string;
  action?: string;
  issues: readonly EvidenceReviewIssue[];
}

const requiredFiles = ['summary.json', 'trace.json', 'artifact-manifest.json'] as const;

/** The ledger's mismatch, which a `Replaced` status already explains. */
export const REPLACED_RECORDING_MESSAGE = 'The task ledger belongs to another recipe execution.';

/**
 * "Recording 15:26" from a recipe-runs directory (`…/20261101072653297-84101/…`). The stamp
 * is UTC (`toISOString`); the label shows the viewer's local time, like the other run times.
 */
export function recipeRecordingLabel(path: string | undefined): string | undefined {
  const stamp = path?.match(/(?:^|\/)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{5}-\d+(?:\/|$)/u);
  if (!stamp) return undefined;
  const [year, month, day, hours, minutes] = stamp.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const time = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Recording ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** Presentation only. Raw reader/validator failures continue to refuse measured proof. */
export function evidenceReviewPackageStatus(
  pkg: RecordedEvidencePackageInput | undefined,
  packagePath: string | undefined,
  messages: readonly string[],
  contractVersion = 1,
  /** A newer recording replaced this package: its findings belong to old evidence. */
  replacedBy?: string,
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
    if (replacedBy && message === REPLACED_RECORDING_MESSAGE) continue;
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
  const legacy = Boolean(contractVersion === 0 && pkg && !current);
  const unsupported = contractVersion !== 0 && contractVersion !== 1;
  const status = legacy
    ? 'Legacy'
    : replacedBy
      ? 'Replaced'
      : grouped.size || unsupported
        ? 'Invalid'
        : 'Valid';
  const otherIssues = grouped.size
    ? ` · ${grouped.size} other issue${grouped.size === 1 ? '' : 's'}`
    : '';
  return {
    status,
    tone: status === 'Invalid' ? 'error' : status === 'Valid' ? 'success' : 'info',
    ...(status === 'Invalid'
      ? {
          reasonCode: unsupported
            ? ('evidence-contract-unsupported' as const)
            : ('evidence-package-unverifiable' as const),
        }
      : {}),
    path: (packagePath ?? '.').replace(/^artifacts\//u, '').replace(/\/$/u, '') || '.',
    summary: legacy
      ? `Recorded before Recipe v1: not machine-checkable${missing.length ? ` (missing ${missing.join(', ')})` : ''}; media untimed`
      : replacedBy
        ? `Evidence replaced by ${replacedBy.replace(/^Recording/u, 'recording')}${otherIssues}`
        : unsupported
          ? 'The recorded run evidence contract is unsupported; measured proof unavailable'
          : status === 'Invalid'
            ? `${grouped.size} evidence issue${grouped.size === 1 ? '' : 's'}; measured proof unavailable`
            : 'Recipe evidence is machine-checkable',
    ...(status === 'Invalid' || status === 'Replaced'
      ? { action: 'Refresh the gate package or re-run the recipe.' }
      : {}),
    issues: [...grouped.values()],
  };
}
