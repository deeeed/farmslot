import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatVoiceAsrModelSize,
  formatVoiceAsrSmokeTestResult,
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
  normalizeVoiceAsrTextForMatch,
  resolveVoiceAsrModelPreference,
  voiceAsrTranscriptMatchesExpected,
} from './voice-asr-models';

test('Whisper ASR model requires encoder decoder and tokens files', () => {
  const model = getVoiceAsrModel('whisper-tiny-en');

  assert.deepEqual(getVoiceAsrRequiredRelativePaths(model), [
    'tiny.en-encoder.int8.onnx',
    'tiny.en-decoder.int8.onnx',
    'tiny.en-tokens.txt',
  ]);
  assert.equal(getVoiceAsrArchiveFileName(model), 'sherpa-onnx-whisper-tiny.en.tar.bz2');
});

test('Qwen3 ASR model requires tokenizer contents, not only tokenizer directory', () => {
  const model = getVoiceAsrModel('qwen3-asr-0.6B-int8-2026-03-25');

  assert.deepEqual(getVoiceAsrRequiredRelativePaths(model), [
    'encoder.int8.onnx',
    'decoder.int8.onnx',
    'conv_frontend.onnx',
    'tokenizer',
    'tokenizer/vocab.json',
    'tokenizer/merges.txt',
    'tokenizer/tokenizer_config.json',
  ]);
  assert.equal(
    getVoiceAsrArchiveFileName(model),
    'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
  );
});

test('formatVoiceAsrModelSize keeps compact mobile labels', () => {
  assert.equal(formatVoiceAsrModelSize(113 * 1024 * 1024), '113 MB');
  assert.equal(formatVoiceAsrModelSize(512 * 1024), '512 KB');
  assert.equal(formatVoiceAsrModelSize(1842 * 1024 * 1024), '1.8 GB');
});

test('voice ASR model badges distinguish quick setup from quality download', () => {
  assert.equal(getVoiceAsrModelBadge(getVoiceAsrModel('whisper-tiny-en')), 'Quick default');
  assert.equal(
    getVoiceAsrModelBadge(getVoiceAsrModel('qwen3-asr-0.6B-int8-2026-03-25')),
    'Quality heavy',
  );
});

test('voice ASR model source labels explain configured versus managed models', () => {
  assert.equal(getVoiceAsrModelSourceLabel('configured'), 'Configured path');
  assert.equal(getVoiceAsrModelSourceLabel('managed'), 'Managed download');
});

test('voice ASR configured directory paths infer the intended model', () => {
  assert.equal(
    getVoiceAsrModelIdFromDirectory('/tmp/farmslot-models/qwen3-asr-0.6B-int8-2026-03-25'),
    'qwen3-asr-0.6B-int8-2026-03-25',
  );
  assert.equal(
    getVoiceAsrModelIdFromDirectory('/tmp/models/sherpa-onnx-whisper-tiny.en'),
    'whisper-tiny-en',
  );
  assert.equal(getVoiceAsrModelIdFromDirectory('/tmp/models/unknown'), null);
});

test('voice ASR stored preference accepts known models and removes stale ids', () => {
  assert.deepEqual(getStoredVoiceAsrModelPreference(' whisper-tiny-en '), {
    modelId: 'whisper-tiny-en',
    shouldRemove: false,
    message: null,
  });
  assert.deepEqual(getStoredVoiceAsrModelPreference('retired-model'), {
    modelId: null,
    shouldRemove: true,
    message: "Removed unknown saved ASR model 'retired-model'.",
  });
  assert.deepEqual(getStoredVoiceAsrModelPreference(null), {
    modelId: null,
    shouldRemove: false,
    message: null,
  });
});

test('voice ASR preference resolver uses configured, stored, current, then default model order', () => {
  assert.deepEqual(
    resolveVoiceAsrModelPreference({
      configuredModelId: 'qwen3-asr-0.6B-int8-2026-03-25',
      storedModelId: 'whisper-tiny-en',
      currentModelId: 'whisper-tiny-en',
    }),
    {
      modelId: 'qwen3-asr-0.6B-int8-2026-03-25',
      shouldRemoveStoredPreference: false,
      message: null,
    },
  );
  assert.deepEqual(
    resolveVoiceAsrModelPreference({
      storedModelId: 'qwen3-asr-0.6B-int8-2026-03-25',
      currentModelId: 'whisper-tiny-en',
    }),
    {
      modelId: 'qwen3-asr-0.6B-int8-2026-03-25',
      shouldRemoveStoredPreference: false,
      message: null,
    },
  );
  assert.deepEqual(
    resolveVoiceAsrModelPreference({
      storedModelId: 'retired-model',
      currentModelId: 'qwen3-asr-0.6B-int8-2026-03-25',
    }),
    {
      modelId: 'qwen3-asr-0.6B-int8-2026-03-25',
      shouldRemoveStoredPreference: true,
      message: "Removed unknown saved ASR model 'retired-model'.",
    },
  );
  assert.equal(
    resolveVoiceAsrModelPreference({ currentModelId: 'unknown' }).modelId,
    'whisper-tiny-en',
  );
});

test('voice ASR downloads reserve space for archive and extraction', () => {
  assert.equal(getVoiceAsrMinimumFreeBytes(getVoiceAsrModel('whisper-tiny-en')), 339 * 1024 * 1024);
  assert.equal(
    getVoiceAsrMinimumFreeBytes(getVoiceAsrModel('qwen3-asr-0.6B-int8-2026-03-25')),
    1842 * 1024 * 1024,
  );
});

test('voice ASR storage labels include download and free-space requirements', () => {
  assert.equal(
    getVoiceAsrStorageRequirementLabel(getVoiceAsrModel('whisper-tiny-en')),
    '113 MB download · 339 MB free required',
  );
  assert.equal(
    getVoiceAsrStorageRequirementLabel(getVoiceAsrModel('qwen3-asr-0.6B-int8-2026-03-25')),
    '614 MB download · 1.8 GB free required',
  );
});

test('voice ASR setup action downloads managed missing models inline', () => {
  assert.deepEqual(
    getVoiceAsrSetupAction({
      runtimeReady: true,
      modelStatus: 'not_downloaded',
      modelSource: 'managed',
      isDownloading: false,
      hasEditableInstruction: false,
      isRecordingOrTranscribing: false,
      isFormatting: false,
    }),
    { visible: true, enabled: true, label: 'Download', mode: 'download' },
  );
});

test('voice ASR setup action routes configured model problems to settings', () => {
  assert.deepEqual(
    getVoiceAsrSetupAction({
      runtimeReady: true,
      modelStatus: 'incomplete',
      modelSource: 'configured',
      isDownloading: false,
      hasEditableInstruction: false,
      isRecordingOrTranscribing: false,
      isFormatting: false,
    }),
    { visible: true, enabled: true, label: 'Setup', mode: 'settings' },
  );
});

test('voice ASR setup action stays hidden while drafting or runtime is unavailable', () => {
  const hidden = { visible: false, enabled: false, label: 'Setup', mode: 'none' };
  assert.deepEqual(
    getVoiceAsrSetupAction({
      runtimeReady: false,
      modelStatus: 'not_downloaded',
      modelSource: 'managed',
      isDownloading: false,
      hasEditableInstruction: false,
      isRecordingOrTranscribing: false,
      isFormatting: false,
    }),
    hidden,
  );
  assert.deepEqual(
    getVoiceAsrSetupAction({
      runtimeReady: true,
      modelStatus: 'not_downloaded',
      modelSource: 'managed',
      isDownloading: false,
      hasEditableInstruction: true,
      isRecordingOrTranscribing: false,
      isFormatting: false,
    }),
    hidden,
  );
});

test('voice ASR setup action shows download progress label', () => {
  assert.deepEqual(
    getVoiceAsrSetupAction({
      runtimeReady: true,
      modelStatus: 'extracting',
      modelSource: 'managed',
      isDownloading: true,
      hasEditableInstruction: false,
      isRecordingOrTranscribing: false,
      isFormatting: false,
    }),
    { visible: true, enabled: false, label: 'Extract', mode: 'none' },
  );
});

test('voice ASR smoke test matching tolerates punctuation and extra words in order', () => {
  assert.deepEqual(normalizeVoiceAsrTextForMatch('Please, report current status!'), [
    'please',
    'report',
    'current',
    'status',
  ]);
  assert.equal(
    voiceAsrTranscriptMatchesExpected(
      'Okay, please report the current status now.',
      'Please report current status.',
    ),
    true,
  );
  assert.equal(
    voiceAsrTranscriptMatchesExpected(
      'Please give current status.',
      'Please report current status.',
    ),
    false,
  );
});

test('voice ASR smoke test result formatting is shared by settings and terminal', () => {
  assert.equal(
    formatVoiceAsrSmokeTestResult({
      transcript: 'Please report current status.',
      expectedText: 'Please report current status.',
    }),
    'heard: “Please report current status.” (expected: “Please report current status.”)',
  );
});
