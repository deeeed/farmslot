export interface SupportHashFile {
  relativePath: string;
  contentBase64: string;
  mode: number;
}
export interface SupportFilePath {
  relativePath: string;
  sourcePath?: string;
}
export interface SupportBundle {
  files: SupportHashFile[];
  hash: string;
}
export const RUNNER_OBSERVABILITY_COPY_PATHS: readonly string[];
export const RUNNER_OBSERVABILITY_SUPPORT_PATHS: readonly string[];
export const RUNNER_OBSERVABILITY_SOURCE_FILES: readonly SupportFilePath[];
export const RUNNER_OBSERVABILITY_COPY_FILES: readonly SupportFilePath[];
export function supportHash(files: readonly SupportHashFile[]): string;
export function readSupportFiles(
  root: string,
  entries: readonly SupportFilePath[],
): Promise<SupportHashFile[]>;
export function verifySupportBundle(
  root: string | null,
  expectedHash: string | undefined,
  entries: readonly SupportFilePath[],
): Promise<SupportBundle>;
export function supportVerificationProgram(): string;
