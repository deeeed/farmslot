export const RUN_BUNDLE_VERSION = 1 as const;

export type RunBundleProfile = 'reference' | 'family' | 'full';

export type RunBundleRemapPolicy = 'preserve-ids' | 'remap-ids' | 'reference-only';

export type RunBundleImportMode = 'reference-only' | 'seed' | 'mirror';

export interface RunImportProvenance {
  importedFromRunId: string;
  importedAt: string;
  sourceGatewayUrl?: string;
  sourceFarmslotRoot?: string;
  bundleId?: string;
  mode: RunBundleImportMode;
}

export interface RunBundleSource {
  gatewayUrl?: string;
  farmslotRoot: string;
  runIds: string[];
}

export interface RunBundleEntryMeta {
  sha256: string;
  bytes: number;
  path: string;
}

export interface RunBundleRunEntry {
  originalRunId: string;
  runPath: string;
  taskKey?: string;
  taskRelativePath?: string;
  packagePaths?: string[];
  missingData?: string[];
}

export interface RunBundleManifest {
  version: typeof RUN_BUNDLE_VERSION;
  profile: RunBundleProfile;
  exportedAt: string;
  bundleId: string;
  source: RunBundleSource;
  remapPolicy: RunBundleRemapPolicy;
  runs: RunBundleRunEntry[];
  entries: Record<string, RunBundleEntryMeta>;
  missingData?: string[];
}

export interface RunBundleExportRequest {
  farmslotRoot: string;
  runIds?: string[];
  profile: RunBundleProfile;
  gatewayUrl?: string;
  remapPolicy?: RunBundleRemapPolicy;
}

export interface RunBundleExportResult {
  manifest: RunBundleManifest;
  outputPath: string;
  runCount: number;
}

export interface RunBundleImportRequest {
  farmslotRoot: string;
  bundlePath: string;
  mode: RunBundleImportMode;
  force?: boolean;
}

export interface RunBundleImportResult {
  manifest: RunBundleManifest;
  importedRunIds: string[];
  idMap: Record<string, string>;
  packagePaths: string[];
}

export interface RunBundleListResult {
  manifest: RunBundleManifest;
}



export function isRunBundleProfile(value: unknown): value is RunBundleProfile {
  return value === 'reference' || value === 'family' || value === 'full';
}

export function isRunBundleImportMode(value: unknown): value is RunBundleImportMode {
  return value === 'reference-only' || value === 'seed' || value === 'mirror';
}

export function isRunBundleManifest(value: unknown): value is RunBundleManifest {
  if (!value || typeof value !== 'object') return false;
  const record = value as RunBundleManifest;
  return (
    record.version === RUN_BUNDLE_VERSION &&
    isRunBundleProfile(record.profile) &&
    typeof record.exportedAt === 'string' &&
    typeof record.bundleId === 'string' &&
    !!record.source &&
    typeof record.source.farmslotRoot === 'string' &&
    Array.isArray(record.source.runIds) &&
    typeof record.remapPolicy === 'string' &&
    Array.isArray(record.runs) &&
    !!record.entries &&
    typeof record.entries === 'object'
  );
}