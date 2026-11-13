export const PUBLICATION_PUSH_TIMEOUT_MS: number;
export const GIT_PUSH_TIMEOUT_SETTING: string;
export function withFarmGitConfig(command: string): string;
export function withFarmGitArgv(argv: string[]): string[];
export function gitPushTimeoutMs(raw?: string): number;
export class GitPushTimeoutError extends Error {}
export function gitPushTimeoutError(timeoutMs: number): GitPushTimeoutError;
