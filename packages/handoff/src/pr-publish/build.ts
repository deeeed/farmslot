import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** One evidence artifact selected for the PR evidence block. */
export interface PrEvidenceItem {
  /** Package- or artifacts-relative path. */
  path: string;
  description?: string;
}

export interface BuildPrPackageOptions {
  /** PR/task title. */
  title: string;
  /** Absolute artifacts dir; report.md (when present) seeds the summary. */
  artifactsDir?: string;
  /** Explicit summary markdown - wins over report.md. */
  summary?: string;
  /** Evidence items rendered into the evidence block. */
  evidence?: PrEvidenceItem[];
  /** Optional PR body template with {{title}}/{{summary}}/{{evidence}} slots. */
  prTemplate?: string;
}

export interface BuildPrPackageResult {
  prDescriptionMarkdown: string;
  evidenceMarkdown: string;
}

const DEFAULT_PR_TEMPLATE = `## {{title}}

{{summary}}

{{evidence}}
`;

/**
 * Build the PR description + evidence block. Pure and local: writes nothing to
 * GitHub or disk (design section 3 - \`publishPrEvidence\` is the only writer).
 *
 * v1 minimal implementation: title/summary/evidence composition through an
 * optional template. Farm-tier section-map configs and repo PR-template
 * resolution are not implemented yet.
 */
export function buildPrPackage(options: BuildPrPackageOptions): BuildPrPackageResult {
  let summary = options.summary;
  if (summary === undefined && options.artifactsDir) {
    const reportPath = path.join(options.artifactsDir, 'report.md');
    if (existsSync(reportPath)) summary = readFileSync(reportPath, 'utf8').trim();
  }
  summary ??= '_No summary provided._';

  const items = options.evidence ?? [];
  const evidenceMarkdown =
    items.length === 0
      ? ''
      : [
          '## Evidence',
          '',
          ...items.map((e) => `- \`${e.path}\`${e.description ? ` - ${e.description}` : ''}`),
          '',
        ].join('\n');

  const template = options.prTemplate ?? DEFAULT_PR_TEMPLATE;
  const prDescriptionMarkdown = template
    .replace(/\{\{title\}\}/g, options.title)
    .replace(/\{\{summary\}\}/g, summary)
    .replace(/\{\{evidence\}\}/g, evidenceMarkdown)
    .replace(/\n{3,}/g, '\n\n');

  return { prDescriptionMarkdown, evidenceMarkdown };
}
