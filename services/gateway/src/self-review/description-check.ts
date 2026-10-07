// description-check.ts — the self-review rule that a PR says what it does
// (F42). The gateway appends one section to every self-review document, so
// every farm gets the same rule from one place, and runs a deterministic
// pre-check whose findings the reviewer must confirm or dismiss.

export type DescriptionCheckCode =
  | 'DESCRIPTION_CLAIM_NOT_IN_DIFF'
  | 'DIFF_CHANGE_NOT_DESCRIBED'
  | 'FLAG_STATE_EVIDENCE_MISSING';

export interface DescriptionCheckFinding {
  code: DescriptionCheckCode;
  detail: string;
}

export interface DescriptionCheckInput {
  /** The final PR description, or null when the worker wrote none. */
  description: string | null;
  commitSubjects: readonly string[];
  /** Unified diff of base...HEAD. */
  diff: string;
  /** Parsed artifacts/evidence-manifest.json, or null when absent. */
  evidenceManifest: unknown;
}

const REMOVAL_CLAIM = /\b(remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|strip(?:s|ped|ping)?)\b/i;
// Flags and config switches as they appear in code. Broad on purpose: a hit is
// a lead the reviewer confirms, never a verdict on its own.
const FLAG_IN_CODE =
  /feature[\s_-]?flags?|featureflag|isFeatureEnabled|remote[\s_-]?config|kill[\s_-]?switch/i;
const FLAG_OFF_LABEL = /\bflag[\s_-]*(?:off|disabled)\b/i;
const FLAG_ON_LABEL = /\bflag[\s_-]*(?:on|enabled)\b/i;

interface DiffSummary {
  deletedFiles: number;
  removedLines: number;
  flagLines: string[];
}

function summarizeDiff(diff: string): DiffSummary {
  const summary: DiffSummary = { deletedFiles: 0, removedLines: 0, flagLines: [] };
  for (const line of diff.split('\n')) {
    if (line.startsWith('deleted file mode')) summary.deletedFiles += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) summary.removedLines += 1;
    else if (line.startsWith('+') && !line.startsWith('+++') && FLAG_IN_CODE.test(line))
      summary.flagLines.push(line.slice(1).trim());
  }
  return summary;
}

function firstClaim(
  description: string | null,
  commitSubjects: readonly string[],
): { source: string; text: string } | null {
  for (const line of (description ?? '').split('\n')) {
    if (REMOVAL_CLAIM.test(line)) return { source: 'description', text: line.trim() };
  }
  for (const subject of commitSubjects) {
    if (REMOVAL_CLAIM.test(subject)) return { source: 'commit subject', text: subject.trim() };
  }
  return null;
}

function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

interface ManifestPair {
  label?: unknown;
  before?: unknown;
  after?: unknown;
}

function flagStatesCovered(manifest: unknown): { off: boolean; on: boolean } {
  const pairs = (manifest as { before_after_pairs?: unknown } | null)?.before_after_pairs;
  const complete = (Array.isArray(pairs) ? (pairs as ManifestPair[]) : []).filter(
    (pair) => typeof pair.label === 'string' && !!pair.before && !!pair.after,
  );
  return {
    off: complete.some((pair) => FLAG_OFF_LABEL.test(pair.label as string)),
    on: complete.some((pair) => FLAG_ON_LABEL.test(pair.label as string)),
  };
}

/**
 * The mismatches a scan can see: a removal the diff does not make, and a flag
 * change without evidence for both states. Whether every user-visible change is
 * described needs judgment, so DIFF_CHANGE_NOT_DESCRIBED is left to the reviewer.
 */
export function descriptionCheckFindings(input: DescriptionCheckInput): DescriptionCheckFinding[] {
  const findings: DescriptionCheckFinding[] = [];
  const diff = summarizeDiff(input.diff);
  const claim = firstClaim(input.description, input.commitSubjects);
  if (claim && diff.deletedFiles === 0 && diff.removedLines === 0) {
    findings.push({
      code: 'DESCRIPTION_CLAIM_NOT_IN_DIFF',
      detail: `The ${claim.source} claims a removal ("${clip(claim.text)}") but the diff removes nothing.`,
    });
  } else if (claim && diff.deletedFiles === 0 && diff.flagLines.length > 0) {
    findings.push({
      code: 'DESCRIPTION_CLAIM_NOT_IN_DIFF',
      detail: `The ${claim.source} claims a removal ("${clip(claim.text)}") but the diff deletes no file and gates behaviour behind a flag ("${clip(diff.flagLines[0]!)}"). Describe what is hidden, and behind which flag.`,
    });
  }
  if (diff.flagLines.length > 0) {
    const states = flagStatesCovered(input.evidenceManifest);
    const missing = [!states.off && '"flag off"', !states.on && '"flag on"'].filter(Boolean);
    if (missing.length > 0) {
      findings.push({
        code: 'FLAG_STATE_EVIDENCE_MISSING',
        detail: `The diff uses a flag ("${clip(diff.flagLines[0]!)}") but the evidence manifest has no before/after pair labelled ${missing.join(' or ')}.`,
      });
    }
  }
  return findings;
}

export interface DescriptionCheckSectionInput {
  repo: string;
  taskDir: string;
  /** The PR's base branch: the stack base for a stacked run, else the default branch. */
  baseBranch: string;
  /** Pre-check findings, or the reason the pre-check could not run. */
  preCheck: DescriptionCheckFinding[] | { unavailable: string };
}

/** The gateway-owned self-review section. */
export function buildDescriptionCheckSection(input: DescriptionCheckSectionInput): string {
  const description = `${input.taskDir}/artifacts/pr-description.md`;
  const manifest = `${input.taskDir}/artifacts/evidence-manifest.json`;
  const base = `origin/${input.baseBranch}`;
  const preCheck = Array.isArray(input.preCheck)
    ? input.preCheck.length > 0
      ? input.preCheck.map((finding) => `- \`${finding.code}\`: ${finding.detail}`)
      : ['- None found.']
    : [`- Not run: ${input.preCheck.unavailable}.`];
  return [
    '## Description and evidence check',
    '',
    'Before your verdict, compare what the PR says with what it does:',
    '',
    '```bash',
    `cd ${input.repo}`,
    `git fetch origin ${input.baseBranch}`,
    `git diff ${base}...HEAD`,
    `git log --format=%s ${base}..HEAD`,
    `cat ${description}`,
    `cat ${manifest}`,
    '```',
    '',
    `Report each mismatch as an issue on \`${description}\` (description and commit findings) or \`${manifest}\` (evidence findings), starting with its name:`,
    '',
    '- `DESCRIPTION_CLAIM_NOT_IN_DIFF`: the description or a commit subject claims something the diff does not do. Saying "remove", "delete" or "strip" while the diff hides the surface behind a flag is this finding.',
    '- `DIFF_CHANGE_NOT_DESCRIBED`: a user-visible change in the diff is missing from the description.',
    '- `FLAG_STATE_EVIDENCE_MISSING`: the change adds or uses a feature flag or config switch to hide, gate or change behaviour, and the evidence manifest lacks a before/after pair for each state: one labelled "flag off" (today\'s behaviour, unchanged) and one labelled "flag on" (the new behaviour).',
    '',
    '### Gateway pre-check',
    '',
    ...preCheck,
    '',
    'A pre-check finding is a lead, not a verdict: report it as an issue, or say in your summary why it does not apply.',
  ].join('\n');
}
