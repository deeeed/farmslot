import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ArtifactsIndex, PrConsent } from '../spec/types.js';

export interface PublishPrEvidenceOptions {
  /** Assembled learning-package dir whose retained artifacts are the upload set. */
  packageDir: string;
  /** PR URL or org/repo#number to attach evidence to. */
  prRef?: string;
  /**
   * Explicit per-call consent (design section 3): NEVER resolved from any file,
   * never sticky. Both grants must be literally true for a real publish;
   * `dryRun` needs none (aligned with writeLearningPackage: no approver
   * present = preview only, not an error).
   */
  consent?: PrConsent;
  /** Compute the upload plan without any network or GitHub write. */
  dryRun?: boolean;
}

export interface PublishPrEvidenceResult {
  status: 'dry-run';
  /** Package-relative artifact paths that a real publish would upload. */
  wouldUpload: string[];
  updatedPr: false;
}

/**
 * Publish PR evidence. A REAL publish requires explicit per-call consent; a
 * dry-run computes the local upload plan without consent (same asymmetry as
 * writeLearningPackage - no approver present means preview, not an error).
 *
 * v1 STUB for the write path: only `dryRun: true` is implemented (returns the
 * upload plan from artifacts/index.json). The actual upload/PR-update transport
 * is not implemented yet and throws a clear error rather than pretending.
 */
export function publishPrEvidence(options: PublishPrEvidenceOptions): PublishPrEvidenceResult {
  if (
    !options.dryRun &&
    (options.consent?.githubWrite !== true || options.consent?.publicUpload !== true)
  ) {
    throw new Error(
      'publishPrEvidence: refusing without explicit per-call consent ' +
        '({ githubWrite: true, publicUpload: true, grantedAt }). Consent is never read ' +
        'from a file and never sticky. Next: pass the consent the caller just granted, ' +
        'or use dryRun: true to preview the upload plan.',
    );
  }

  const indexPath = path.join(options.packageDir, 'artifacts/index.json');
  if (!existsSync(indexPath)) {
    throw new Error(
      `publishPrEvidence: no artifacts/index.json under ${options.packageDir}. ` +
        'Next: pass the packageDir from a status:"ok" AssembleResult.',
    );
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as ArtifactsIndex;
  const wouldUpload = index.artifacts.map((a) => a.path);

  if (options.dryRun) {
    return { status: 'dry-run', wouldUpload, updatedPr: false };
  }

  throw new Error(
    'publishPrEvidence: the upload/PR-update transport is not implemented in v1. ' +
      'Next: use dryRun: true for the upload plan, or publish evidence with your ' +
      'existing farm tooling until this lands.',
  );
}
