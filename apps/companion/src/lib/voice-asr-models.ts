import type { AsrModelConfig } from '@siteed/sherpa-onnx.rn';

export interface VoiceAsrModel {
  id: string;
  name: string;
  description: string;
  recommendedUse: string;
  downloadProfile: 'quick-default' | 'quality-heavy';
  compressedSizeBytes: number;
  url: string;
  archiveRoot: string;
  asrConfig: Omit<AsrModelConfig, 'modelDir'>;
}

export type VoiceAsrModelSource = 'configured' | 'managed';

export type VoiceAsrSetupModelStatus =
  | 'not_downloaded'
  | 'downloading'
  | 'extracting'
  | 'incomplete'
  | 'ready';

export interface VoiceAsrSetupActionInput {
  runtimeReady: boolean | null;
  modelStatus: VoiceAsrSetupModelStatus | null | undefined;
  modelSource: VoiceAsrModelSource | null | undefined;
  isDownloading: boolean;
  hasEditableInstruction: boolean;
  isRecordingOrTranscribing: boolean;
  isFormatting: boolean;
}

export interface VoiceAsrSetupAction {
  visible: boolean;
  enabled: boolean;
  label: 'Download' | 'Load…' | 'Extract' | 'Setup';
  mode: 'download' | 'settings' | 'none';
}

export interface VoiceAsrSmokeTestResult {
  transcript: string;
  expectedText: string;
}

export interface VoiceAsrStoredPreference {
  modelId: string | null;
  shouldRemove: boolean;
  message: string | null;
}

export function normalizeVoiceAsrTextForMatch(text: string): string[] {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

export function voiceAsrTranscriptMatchesExpected(
  transcript: string,
  expectedText: string,
): boolean {
  const transcriptWords = normalizeVoiceAsrTextForMatch(transcript);
  const expectedWords = normalizeVoiceAsrTextForMatch(expectedText);
  if (expectedWords.length === 0 || transcriptWords.length === 0) return false;

  let expectedIndex = 0;
  for (const word of transcriptWords) {
    if (word === expectedWords[expectedIndex]) expectedIndex += 1;
    if (expectedIndex === expectedWords.length) return true;
  }
  return false;
}

export function formatVoiceAsrSmokeTestResult(result: VoiceAsrSmokeTestResult): string {
  return `heard: “${result.transcript}” (expected: “${result.expectedText}”)`;
}

export const DEFAULT_VOICE_ASR_MODEL_ID = 'whisper-tiny-en';

const QWEN3_DEFAULT_TOKENIZER_FILES = ['vocab.json', 'merges.txt', 'tokenizer_config.json'];

export const VOICE_ASR_MODELS: VoiceAsrModel[] = [
  {
    id: 'whisper-tiny-en',
    name: 'Whisper Tiny English',
    description: 'Small offline Whisper model for quick on-device command dictation tests.',
    recommendedUse: 'Fast setup and command dictation smoke tests.',
    downloadProfile: 'quick-default',
    compressedSizeBytes: 113 * 1024 * 1024,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2',
    archiveRoot: 'sherpa-onnx-whisper-tiny.en',
    asrConfig: {
      modelType: 'whisper',
      numThreads: 2,
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
      streaming: false,
      provider: 'cpu',
      language: 'en',
      task: 'transcribe',
      modelFiles: {
        encoder: 'tiny.en-encoder.int8.onnx',
        decoder: 'tiny.en-decoder.int8.onnx',
        tokens: 'tiny.en-tokens.txt',
      },
    },
  },
  {
    id: 'qwen3-asr-0.6B-int8-2026-03-25',
    name: 'Qwen3-ASR 0.6B INT8',
    description: 'Large multilingual offline model; higher quality but a heavy download.',
    recommendedUse:
      'Higher-quality delayed/final transcript checks when Wi-Fi and storage are available.',
    downloadProfile: 'quality-heavy',
    compressedSizeBytes: 614 * 1024 * 1024,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
    archiveRoot: 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25',
    asrConfig: {
      modelType: 'qwen3',
      numThreads: 2,
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
      streaming: false,
      provider: 'cpu',
      modelFiles: {
        encoder: 'encoder.int8.onnx',
        decoder: 'decoder.int8.onnx',
        convFrontend: 'conv_frontend.onnx',
        tokenizer: 'tokenizer',
      },
      qwen3: {
        maxTotalLen: 512,
        maxNewTokens: 128,
        temperature: 1e-6,
        topP: 0.8,
        seed: 42,
      },
    },
  },
];

export function getDefaultVoiceAsrModel(): VoiceAsrModel {
  return getVoiceAsrModel(DEFAULT_VOICE_ASR_MODEL_ID);
}

export function getVoiceAsrModel(modelId: string): VoiceAsrModel {
  const model = VOICE_ASR_MODELS.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Unknown voice ASR model '${modelId}'.`);
  return model;
}

export function isVoiceAsrModelId(modelId: string | null | undefined): modelId is string {
  return typeof modelId === 'string' && VOICE_ASR_MODELS.some((model) => model.id === modelId);
}

export function getStoredVoiceAsrModelPreference(
  storedModelId: string | null | undefined,
): VoiceAsrStoredPreference {
  const normalized = storedModelId?.trim();
  if (!normalized) return { modelId: null, shouldRemove: false, message: null };
  if (isVoiceAsrModelId(normalized)) {
    return { modelId: normalized, shouldRemove: false, message: null };
  }
  return {
    modelId: null,
    shouldRemove: true,
    message: `Removed unknown saved ASR model '${normalized}'.`,
  };
}

export interface ResolveVoiceAsrModelPreferenceInput {
  configuredModelId?: string | null;
  storedModelId?: string | null;
  currentModelId?: string | null;
}

export interface ResolvedVoiceAsrModelPreference {
  modelId: string;
  shouldRemoveStoredPreference: boolean;
  message: string | null;
}

export function resolveVoiceAsrModelPreference({
  configuredModelId,
  storedModelId,
  currentModelId,
}: ResolveVoiceAsrModelPreferenceInput): ResolvedVoiceAsrModelPreference {
  if (isVoiceAsrModelId(configuredModelId)) {
    return {
      modelId: configuredModelId,
      shouldRemoveStoredPreference: false,
      message: null,
    };
  }

  const current = isVoiceAsrModelId(currentModelId) ? currentModelId : DEFAULT_VOICE_ASR_MODEL_ID;
  const storedPreference = getStoredVoiceAsrModelPreference(storedModelId);
  if (storedPreference.modelId) {
    return {
      modelId: storedPreference.modelId,
      shouldRemoveStoredPreference: false,
      message: null,
    };
  }

  return {
    modelId: current,
    shouldRemoveStoredPreference: storedPreference.shouldRemove,
    message: storedPreference.message,
  };
}

export function getVoiceAsrModelIdFromDirectory(
  modelDir: string | null | undefined,
): string | null {
  const normalizedPath = modelDir?.trim().replace(/\\/g, '/');
  if (!normalizedPath) return null;
  const pathSegments = normalizedPath.split('/').filter(Boolean);
  const matchedModel = VOICE_ASR_MODELS.find(
    (model) => pathSegments.includes(model.id) || pathSegments.includes(model.archiveRoot),
  );
  return matchedModel?.id ?? null;
}

export function getVoiceAsrArchiveFileName(model: VoiceAsrModel): string {
  const fileName = model.url.split('/').pop()?.trim();
  if (!fileName) throw new Error(`Voice ASR model '${model.id}' has no archive file name.`);
  return fileName;
}

export function getVoiceAsrRequiredRelativePaths(model: VoiceAsrModel): string[] {
  const requiredPaths = Object.values(model.asrConfig.modelFiles ?? {}).filter(
    (path): path is string => typeof path === 'string' && path.trim().length > 0,
  );
  const tokenizerPath = model.asrConfig.modelFiles?.tokenizer;
  if (
    model.asrConfig.modelType === 'qwen3' &&
    typeof tokenizerPath === 'string' &&
    tokenizerPath.trim()
  ) {
    requiredPaths.push(
      ...QWEN3_DEFAULT_TOKENIZER_FILES.map((fileName) => `${tokenizerPath}/${fileName}`),
    );
  }
  return [...new Set(requiredPaths)];
}

export function formatVoiceAsrModelSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  const gigabytes = bytes / (1024 * 1024 * 1024);
  return `${Number(gigabytes.toFixed(1))} GB`;
}

export function getVoiceAsrMinimumFreeBytes(model: VoiceAsrModel): number {
  return Math.ceil(model.compressedSizeBytes * 3);
}

export function getVoiceAsrStorageRequirementLabel(model: VoiceAsrModel): string {
  return `${formatVoiceAsrModelSize(model.compressedSizeBytes)} download · ${formatVoiceAsrModelSize(
    getVoiceAsrMinimumFreeBytes(model),
  )} free required`;
}

export function getVoiceAsrModelBadge(model: VoiceAsrModel): string {
  if (model.downloadProfile === 'quick-default') return 'Quick default';
  return 'Quality heavy';
}

export function getVoiceAsrModelSourceLabel(source: VoiceAsrModelSource): string {
  return source === 'configured' ? 'Configured path' : 'Managed download';
}

export function getVoiceAsrSetupAction({
  runtimeReady,
  modelStatus,
  modelSource,
  isDownloading,
  hasEditableInstruction,
  isRecordingOrTranscribing,
  isFormatting,
}: VoiceAsrSetupActionInput): VoiceAsrSetupAction {
  const visible =
    runtimeReady === true &&
    modelStatus != null &&
    modelStatus !== 'ready' &&
    !hasEditableInstruction &&
    !isRecordingOrTranscribing &&
    !isFormatting;

  if (!visible) {
    return { visible: false, enabled: false, label: 'Setup', mode: 'none' };
  }

  if (isDownloading) {
    return {
      visible: true,
      enabled: false,
      label: modelStatus === 'extracting' ? 'Extract' : 'Load…',
      mode: 'none',
    };
  }

  if (modelSource === 'managed') {
    return { visible: true, enabled: true, label: 'Download', mode: 'download' };
  }

  return { visible: true, enabled: true, label: 'Setup', mode: 'settings' };
}
