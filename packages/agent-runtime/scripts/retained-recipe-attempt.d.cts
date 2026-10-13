import type { LatestValidRecipeRunPointer } from '@farmslot/protocol/recipe';

export function readRecipeAttemptSelection(taskDir: string): LatestValidRecipeRunPointer | null;
export function recordRecipeAttemptSelection(taskDir: string, artifactDir: string): boolean;
