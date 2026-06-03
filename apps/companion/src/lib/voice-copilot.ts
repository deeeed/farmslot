import type { AudioRecording } from '@siteed/audio-studio';
import SherpaOnnx, { ASR } from '@siteed/sherpa-onnx.rn';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';

import {
  DEFAULT_VOICE_ASR_MODEL_ID,
  formatVoiceAsrModelSize,
  getVoiceAsrArchiveFileName,
  getVoiceAsrMinimumFreeBytes,
  getVoiceAsrModel,
  getVoiceAsrModelIdFromDirectory,
  getVoiceAsrRequiredRelativePaths,
  isVoiceAsrModelId,
  type VoiceAsrModel,
  type VoiceAsrModelSource,
  type VoiceAsrSmokeTestResult,
  voiceAsrTranscriptMatchesExpected,
} from './voice-asr-models';

export {
  DEFAULT_VOICE_ASR_MODEL_ID,
  formatVoiceAsrModelSize,
  formatVoiceAsrSmokeTestResult,
  getDefaultVoiceAsrModel,
  getStoredVoiceAsrModelPreference,
  getVoiceAsrArchiveFileName,
  getVoiceAsrMinimumFreeBytes,
  getVoiceAsrModel,
  getVoiceAsrModelBadge,
  getVoiceAsrModelIdFromDirectory,
  getVoiceAsrModelSourceLabel,
  getVoiceAsrRequiredRelativePaths,
  getVoiceAsrSetupAction,
  getVoiceAsrStorageRequirementLabel,
  isVoiceAsrModelId,
  resolveVoiceAsrModelPreference,
  VOICE_ASR_MODELS,
  type VoiceAsrModel,
  type VoiceAsrModelSource,
  type VoiceAsrSmokeTestResult,
  voiceAsrTranscriptMatchesExpected,
} from './voice-asr-models';

export const VOICE_MODEL_STORAGE_KEY = '@farmslot:voiceCopilot:selectedAsrModel';
export const VOICE_ASR_TEST_CLIP_TEXT = 'Please report current status.';

export type VoiceCopilotStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'model_unavailable'
  | 'transcript_ready'
  | 'error';

export interface VoiceTranscriptResult {
  status: Exclude<VoiceCopilotStatus, 'idle' | 'recording' | 'transcribing'>;
  transcript: string;
  confidence: number | null;
  recordingUri: string | null;
  message: string;
}

export type VoiceAsrModelStatus =
  | 'not_downloaded'
  | 'downloading'
  | 'extracting'
  | 'incomplete'
  | 'ready';

export interface VoiceAsrModelState {
  model: VoiceAsrModel;
  status: VoiceAsrModelStatus;
  source: VoiceAsrModelSource;
  progress: number | null;
  modelDir: string | null;
  message: string;
  missingFiles?: string[];
}

export interface VoiceCopilotRuntimeState {
  available: boolean;
  message: string;
}

type ExpoExtra = {
  sherpaAsrModelId?: string;
  sherpaAsrModelDir?: string;
};

export function getSherpaAsrModelDir(): string | null {
  const extra = Constants.expoConfig?.extra as ExpoExtra | undefined;
  const modelDir = extra?.sherpaAsrModelDir?.trim();
  return modelDir ? modelDir : null;
}

export function getConfiguredSherpaAsrModelId(): string | null {
  const extra = Constants.expoConfig?.extra as ExpoExtra | undefined;
  const configuredModelId = extra?.sherpaAsrModelId?.trim();
  if (isVoiceAsrModelId(configuredModelId)) return configuredModelId;
  return getVoiceAsrModelIdFromDirectory(getSherpaAsrModelDir());
}

export function getPreferredVoiceAsrModelId(modelId?: string | null): string {
  const requestedModelId = modelId?.trim();
  if (requestedModelId) return requestedModelId;
  return getConfiguredSherpaAsrModelId() ?? DEFAULT_VOICE_ASR_MODEL_ID;
}

export function getVoiceCopilotAvailability(): { available: boolean; message: string } {
  const modelDir = getSherpaAsrModelDir();
  if (!modelDir) {
    return {
      available: true,
      message:
        'Local Sherpa ASR is available after downloading a transcription model. Manual transcript entry remains available.',
    };
  }
  return {
    available: true,
    message: `Local Sherpa ASR model configured at ${modelDir}.`,
  };
}

export async function getVoiceCopilotRuntimeState(): Promise<VoiceCopilotRuntimeState> {
  try {
    const result = await SherpaOnnx.validateLibraryLoaded();
    if (!result.loaded) {
      return {
        available: false,
        message: `Sherpa native runtime is unavailable: ${result.status}. Rebuild the development app before using on-device ASR.`,
      };
    }
    return {
      available: true,
      message: result.status
        ? `Sherpa native runtime ready: ${result.status}.`
        : 'Sherpa native runtime ready.',
    };
  } catch (error) {
    return {
      available: false,
      message: `Sherpa native runtime check failed: ${getErrorMessage(error)}. Rebuild the development app before using on-device ASR.`,
    };
  }
}

export async function getVoiceAsrModelState(modelId?: string | null): Promise<VoiceAsrModelState> {
  const model = getVoiceAsrModel(getPreferredVoiceAsrModelId(modelId));
  const configuredModelDir = getSherpaAsrModelDir();
  if (configuredModelDir) {
    const missingFiles = await getMissingVoiceAsrModelFiles(model, configuredModelDir);
    if (missingFiles.length > 0) {
      return {
        model,
        status: 'incomplete',
        source: 'configured',
        progress: null,
        modelDir: null,
        missingFiles,
        message: `Configured ${model.name} directory is incomplete. Missing ${missingFiles
          .slice(0, 3)
          .join(', ')}${
          missingFiles.length > 3 ? ` and ${missingFiles.length - 3} more` : ''
        }. Fix EXPO_PUBLIC_SHERPA_ASR_MODEL_DIR or rebuild before using on-device transcription.`,
      };
    }
    return {
      model,
      status: 'ready',
      source: 'configured',
      progress: 1,
      modelDir: configuredModelDir,
      message: `${model.name} is ready from configured model directory.`,
    };
  }
  return getManagedVoiceAsrModelState(model.id);
}

async function getManagedVoiceAsrModelState(modelId?: string | null): Promise<VoiceAsrModelState> {
  const model = getVoiceAsrModel(getPreferredVoiceAsrModelId(modelId));
  const modelBaseDir = await SherpaOnnx.Archive.getModelPath('asr', model.id);
  const downloaded = await SherpaOnnx.Archive.isModelDownloaded('asr', model.id);
  const modelDir = `${modelBaseDir}/${model.archiveRoot}`;
  if (!downloaded) {
    return {
      model,
      status: 'not_downloaded',
      source: 'managed',
      progress: null,
      modelDir: null,
      message: `${model.name} is not downloaded (${formatVoiceAsrModelSize(model.compressedSizeBytes)} compressed).`,
    };
  }
  const missingFiles = await getMissingVoiceAsrModelFiles(model, modelDir);
  if (missingFiles.length > 0) {
    return {
      model,
      status: 'incomplete',
      source: 'managed',
      progress: null,
      modelDir: null,
      missingFiles,
      message: `${model.name} is incomplete. Missing ${missingFiles.slice(0, 3).join(', ')}${
        missingFiles.length > 3 ? ` and ${missingFiles.length - 3} more` : ''
      }. Download again before using on-device transcription.`,
    };
  }
  return {
    model,
    status: 'ready',
    source: 'managed',
    progress: 1,
    modelDir,
    message: `${model.name} is ready for on-device transcription.`,
  };
}

export async function downloadVoiceAsrModel(
  modelId?: string | null,
  onState?: (state: VoiceAsrModelState) => void,
): Promise<VoiceAsrModelState> {
  const model = getVoiceAsrModel(getPreferredVoiceAsrModelId(modelId));
  const archiveFileName = getVoiceAsrArchiveFileName(model);
  const freeDiskBytes = await FileSystem.getFreeDiskStorageAsync();
  const requiredFreeBytes = getVoiceAsrMinimumFreeBytes(model);
  if (freeDiskBytes < requiredFreeBytes) {
    throw new Error(
      `Not enough free storage for ${model.name}. Need at least ${formatVoiceAsrModelSize(
        requiredFreeBytes,
      )} free before download/extraction; device reports ${formatVoiceAsrModelSize(freeDiskBytes)} free.`,
    );
  }
  onState?.({
    model,
    status: 'downloading',
    source: 'managed',
    progress: 0,
    modelDir: null,
    message: `Downloading ${model.name}…`,
  });
  const archivePath = await SherpaOnnx.Archive.downloadModel(
    'asr',
    archiveFileName,
    model.url,
    (progress) => {
      onState?.({
        model,
        status: 'downloading',
        source: 'managed',
        progress,
        modelDir: null,
        message: `Downloading ${model.name}: ${Math.round(progress * 100)}%`,
      });
    },
  );
  const modelBaseDir = await SherpaOnnx.Archive.getModelPath('asr', model.id);
  onState?.({
    model,
    status: 'extracting',
    source: 'managed',
    progress: 1,
    modelDir: null,
    message: `Extracting ${model.name}…`,
  });
  const extraction = await SherpaOnnx.Archive.extractTarBz2(archivePath, modelBaseDir);
  if (!extraction.success) {
    throw new Error(extraction.message || `Failed to extract ${model.name}.`);
  }
  let cleanupWarning: string | null = null;
  try {
    await FileSystem.deleteAsync(archivePath, { idempotent: true });
  } catch (error) {
    cleanupWarning = ` Extracted model is usable, but archive cleanup failed: ${getErrorMessage(error)}`;
  }
  const state = await getManagedVoiceAsrModelState(model.id);
  return cleanupWarning ? { ...state, message: `${state.message}${cleanupWarning}` } : state;
}

export async function resetVoiceAsrModel(modelId?: string | null): Promise<VoiceAsrModelState> {
  const model = getVoiceAsrModel(getPreferredVoiceAsrModelId(modelId));
  await SherpaOnnx.Archive.deleteModel('asr', model.id);
  await SherpaOnnx.Archive.deleteModel('asr', getVoiceAsrArchiveFileName(model));
  return getManagedVoiceAsrModelState(model.id);
}

export async function transcribeVoiceInstruction(
  recording: AudioRecording | null,
  modelId?: string | null,
): Promise<VoiceTranscriptResult> {
  if (!recording) {
    return {
      status: 'error',
      transcript: '',
      confidence: null,
      recordingUri: null,
      message: 'Recording stopped without producing an audio file.',
    };
  }
  return transcribeVoiceInstructionFile(recording.fileUri, modelId);
}

export async function smokeTestVoiceAsrModelFile(
  fileUri: string,
  modelId?: string | null,
): Promise<VoiceAsrSmokeTestResult> {
  const result = await transcribeVoiceInstructionFile(fileUri, modelId);
  if (result.status !== 'transcript_ready') {
    throw new Error(result.message);
  }
  if (!voiceAsrTranscriptMatchesExpected(result.transcript, VOICE_ASR_TEST_CLIP_TEXT)) {
    throw new Error(
      `ASR smoke test mismatch: heard “${result.transcript}”; expected “${VOICE_ASR_TEST_CLIP_TEXT}”.`,
    );
  }
  return { transcript: result.transcript, expectedText: VOICE_ASR_TEST_CLIP_TEXT };
}

export async function transcribeVoiceInstructionFile(
  fileUri: string,
  modelId?: string | null,
): Promise<VoiceTranscriptResult> {
  const configuredModelDir = getSherpaAsrModelDir();
  const modelState = configuredModelDir ? null : await getVoiceAsrModelState(modelId);
  const model = modelState?.model ?? getVoiceAsrModel(getPreferredVoiceAsrModelId(modelId));
  const modelDir = configuredModelDir ?? modelState?.modelDir;
  if (configuredModelDir) {
    const missingFiles = await getMissingVoiceAsrModelFiles(model, configuredModelDir);
    if (missingFiles.length > 0) {
      return {
        status: 'model_unavailable',
        transcript: '',
        confidence: null,
        recordingUri: fileUri,
        message: `Configured ${model.name} directory is missing ${missingFiles.slice(0, 3).join(', ')}${
          missingFiles.length > 3 ? ` and ${missingFiles.length - 3} more` : ''
        }.`,
      };
    }
  }
  if (!modelDir) {
    return {
      status: 'model_unavailable',
      transcript: '',
      confidence: null,
      recordingUri: fileUri,
      message:
        modelState?.message ??
        `Download ${model.name} before using on-device transcription, or type the transcript manually.`,
    };
  }

  let transcriptionError: unknown = null;
  let transcript = '';
  try {
    const init = await ASR.initialize({ ...model.asrConfig, modelDir });
    if (!init.success) {
      throw new Error(init.error || `Failed to initialize ${model.name}.`);
    }
    const result = await ASR.recognizeFromFile(fileUri);
    if (!result.success || !result.text?.trim()) {
      throw new Error(result.error || `${model.name} returned no transcript.`);
    }
    transcript = result.text.trim();
  } catch (error) {
    transcriptionError = error;
  }

  try {
    await ASR.release();
  } catch (releaseError) {
    return {
      status: 'error',
      transcript: '',
      confidence: null,
      recordingUri: fileUri,
      message: `Transcription failed: ${getErrorMessage(transcriptionError)} Release also failed: ${getErrorMessage(releaseError)}`,
    };
  }

  if (transcript) {
    return {
      status: 'transcript_ready',
      transcript,
      confidence: null,
      recordingUri: fileUri,
      message: `Transcribed locally with ${model.name}. Review and format before sending.`,
    };
  }

  return {
    status: 'error',
    transcript: '',
    confidence: null,
    recordingUri: fileUri,
    message: `Transcription failed: ${getErrorMessage(transcriptionError)}`,
  };
}

async function getMissingVoiceAsrModelFiles(
  model: VoiceAsrModel,
  modelDir: string,
): Promise<string[]> {
  const missingFiles: string[] = [];
  for (const relativePath of getVoiceAsrRequiredRelativePaths(model)) {
    const fileInfo = await FileSystem.getInfoAsync(`${modelDir}/${relativePath}`);
    if (!fileInfo.exists) missingFiles.push(relativePath);
  }
  return missingFiles;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
