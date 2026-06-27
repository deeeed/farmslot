import type { RunBundleImportMode, RunBundleProfile } from '@farmslot/protocol';

export interface RunsImportCliOptions {
  readOnly?: boolean;
  keepIds?: boolean;
  /** Legacy script alias — prefer --read-only / default / --keep-ids */
  mode?: RunBundleImportMode;
}

export interface RunsExportCliOptions {
  profile?: RunBundleProfile;
  forensic?: boolean;
  familyId?: string;
}

/** Default import: writable sandbox copy (protocol name `seed`). */
export function resolveRunsImportMode(opts: RunsImportCliOptions): RunBundleImportMode {
  const humanFlags = Number(Boolean(opts.readOnly)) + Number(Boolean(opts.keepIds));
  if (humanFlags > 1) {
    throw new Error('Use only one of --read-only or --keep-ids');
  }
  if (opts.mode && humanFlags > 0) {
    throw new Error('Do not combine --mode with --read-only or --keep-ids');
  }
  if (opts.readOnly) return 'reference-only';
  if (opts.keepIds) return 'mirror';
  if (opts.mode) return opts.mode;
  return 'seed';
}

export function resolveRunsExportProfile(opts: RunsExportCliOptions): RunBundleProfile {
  if (opts.profile && opts.forensic) {
    throw new Error('Do not combine --profile with --forensic');
  }
  if (opts.profile) return opts.profile;
  if (opts.forensic) return 'full';
  if (opts.familyId) return 'family';
  return 'reference';
}