import type { ProjectConfig } from '@farmslot/protocol';

export const DEFAULT_RECIPE_PLAYBACK_SLOW_MS = 2000;

export interface RecipeRunnerUiOptions {
  playbackSlowMs: number;
  showPlayback: boolean;
  showArtifactAction: boolean;
  recordVideo: boolean;
}

export function recipeRunnerUiOptions(
  project?: Pick<
    ProjectConfig,
    'recipeRunSupportsPlaybackSlow' | 'recipeRunSupportsVideoRecording'
  > | null,
): RecipeRunnerUiOptions {
  const supportsPlayback = project?.recipeRunSupportsPlaybackSlow === true;
  const supportsVideo = project?.recipeRunSupportsVideoRecording === true;
  return {
    playbackSlowMs: supportsPlayback ? DEFAULT_RECIPE_PLAYBACK_SLOW_MS : 0,
    showPlayback: supportsPlayback,
    showArtifactAction: supportsVideo,
    recordVideo: supportsVideo,
  };
}

export function recipeRunnerUiOptionsForProject(
  projectName: string,
  configs: readonly ProjectConfig[],
): RecipeRunnerUiOptions {
  if (!projectName) return recipeRunnerUiOptions(null);
  return recipeRunnerUiOptions(configs.find((entry) => entry.name === projectName));
}

export async function loadRecipeRunnerUiOptionsForProject(
  projectName: string,
  requestConfigs: () => Promise<readonly ProjectConfig[]>,
): Promise<RecipeRunnerUiOptions> {
  if (!projectName) return recipeRunnerUiOptions(null);
  try {
    const configs = await requestConfigs();
    return recipeRunnerUiOptionsForProject(projectName, configs);
  } catch {
    return recipeRunnerUiOptions(null);
  }
}
