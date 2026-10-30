import type { LatestValidRecipeRunPointer } from '@farmslot/protocol/recipe';

export function readRecipeAttemptSelection(taskDir: string): LatestValidRecipeRunPointer | null;
export function recordRecipeAttemptSelection(taskDir: string, artifactDir: string): boolean;
export function selectRecipeAttempt(taskDir: string, artifactDir: string): Promise<boolean>;
