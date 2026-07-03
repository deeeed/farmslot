import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type RecordingConfig, useAudioRecorder } from '@siteed/audio-studio';
import {
  ChatRecordWidget,
  SPEECH_AMPLITUDE_RANGE,
  waveformBarsFromAudioStudioDataPoints,
  type WaveformPoint,
} from '@siteed/audio-ui';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type ChatConfirmActionResult,
  type ChatHistoryResult,
  type ChatMessage,
  type ChatResponsePayload,
  type ChatSuggestedAction,
  Events,
  Methods,
  type RoadmapSaveResult,
} from '@farmslot/protocol';

import { ensureMicrophonePermission } from '../../lib/audio-permissions';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import {
  getConfiguredSherpaAsrModelId,
  getPreferredVoiceAsrModelId,
  getStoredVoiceAsrModelPreference,
  getVoiceAsrModelState,
  getVoiceCopilotRuntimeState,
  transcribeVoiceInstruction,
  VOICE_MODEL_STORAGE_KEY,
  type VoiceAsrModelState,
  type VoiceCopilotStatus,
} from '../../lib/voice-copilot';
import { useConnectionStore } from '../../store/connection';
import { useDecisionStore } from '../../store/decisions';
import { useFleetStore } from '../../store/fleet';
import { useRunStore } from '../../store/runs';

const SHARED_CHAT_SESSION_ID = 'global';
const VOICE_LIVE_BARS_WINDOW = 56;
const VOICE_RECORDING_CONFIG: RecordingConfig = {
  sampleRate: 16000,
  channels: 1,
  encoding: 'pcm_16bit',
  intervalAnalysis: 100,
  segmentDurationMs: 100,
  keepAwake: false,
  showNotification: false,
  enableProcessing: true,
  keepFullAnalysis: false,
};

const QUICK_PROMPTS = [
  'What needs my attention right now?',
  'Summarize active blockers and stale workers.',
  'Which PRs need review or completion?',
  'Find the safest next action for the current fleet.',
];
type ComposerMode = 'copilot' | 'idea';

export default function CopilotScreen() {
  const { draft: routeDraftParam } = useLocalSearchParams<{ draft?: string | string[] }>();
  const insets = useSafeAreaInsets();
  const voiceRecorder = useAudioRecorder();
  const client = useConnectionStore((s) => s.client);
  const status = useConnectionStore((s) => s.status);
  const fleet = useFleetStore((s) => s.fleet);
  const runs = useRunStore((s) => s.runs);
  const decisions = useDecisionStore((s) => s.decisions);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [savingIdea, setSavingIdea] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>('copilot');
  const [streamingText, setStreamingText] = useState('');
  const [streamingStatus, setStreamingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingActionId, setConfirmingActionId] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceCopilotStatus>('idle');
  const [voiceMessage, setVoiceMessage] = useState('');
  const [voiceRuntimeReady, setVoiceRuntimeReady] = useState<boolean | null>(null);
  const [voiceModelState, setVoiceModelState] = useState<VoiceAsrModelState | null>(null);
  const [selectedVoiceModelId, setSelectedVoiceModelId] = useState(getPreferredVoiceAsrModelId);
  const [isPreparingVoiceRecorder, setIsPreparingVoiceRecorder] = useState(false);
  const [voicePanelWidth, setVoicePanelWidth] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const consumedRouteDraftRef = useRef('');

  const activeRuns = useMemo(
    () => runs.filter((run) => !['done', 'failed', 'cancelled'].includes(run.status)).length,
    [runs],
  );
  const fleetSummary = useMemo(
    () => ({
      slots: fleet?.slots.length ?? 0,
      activeRuns,
      pendingDecisions: decisions.length,
    }),
    [activeRuns, decisions.length, fleet?.slots.length],
  );
  const voiceWaveform = useMemo<WaveformPoint[]>(() => {
    const dataPoints = voiceRecorder.analysisData?.dataPoints ?? [];
    const waveformBars = waveformBarsFromAudioStudioDataPoints(
      dataPoints.map((point, index) => ({
        id: typeof point.id === 'number' ? point.id : index,
        amplitude: point.amplitude,
        rms: point.rms,
        dB: point.dB,
        silent: point.silent,
        startTime: point.startTime,
        endTime: point.endTime,
        startPosition: point.startPosition,
        endPosition: point.endPosition,
        samples: point.samples,
      })),
    );
    return takeVoiceLiveWindow(waveformBars);
  }, [voiceRecorder.analysisData?.dataPoints]);
  const voiceBusy =
    isPreparingVoiceRecorder || voiceStatus === 'recording' || voiceStatus === 'transcribing';
  const voiceControlDisabled =
    isPreparingVoiceRecorder || voiceStatus === 'transcribing' || sending;
  const voiceWidgetWidth = Math.max(1, voicePanelWidth);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const promptOpenMicrophoneSettings = useCallback((message: string) => {
    Alert.alert('Microphone required', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open Settings',
        onPress: () => {
          void Linking.openSettings();
        },
      },
    ]);
  }, []);

  const loadHistory = useCallback(async () => {
    if (!client || status !== 'connected') {
      setMessages([]);
      return;
    }
    setError(null);
    try {
      const result = await client.request<ChatHistoryResult>(Methods.CHAT_HISTORY, {
        sessionId: SHARED_CHAT_SESSION_ID,
        limit: 30,
      });
      setMessages(result.messages);
      scrollToBottom();
    } catch (err) {
      setError(`Failed to load Co-Pilot history: ${(err as Error).message}`);
    }
  }, [client, scrollToBottom, status]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const routeDraft = routeParamString(routeDraftParam).trim();
    if (!routeDraft || consumedRouteDraftRef.current === routeDraft) return;
    consumedRouteDraftRef.current = routeDraft;
    setInput((current) => (current.trim() ? current : routeDraft));
  }, [routeDraftParam]);

  useEffect(() => {
    let disposed = false;
    getVoiceCopilotRuntimeState()
      .then((state) => {
        if (disposed) return;
        setVoiceRuntimeReady(state.available);
        if (!state.available) setVoiceMessage(state.message);
      })
      .catch((error: Error) => {
        if (disposed) return;
        setVoiceRuntimeReady(false);
        setVoiceMessage(`Sherpa native runtime check failed: ${error.message}`);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const refreshVoiceConfiguration = async () => {
      try {
        const configuredModelId = getConfiguredSherpaAsrModelId();
        const storedModelId = await AsyncStorage.getItem(VOICE_MODEL_STORAGE_KEY);
        let nextModelId = configuredModelId ?? selectedVoiceModelId;
        if (!configuredModelId && storedModelId) {
          const storedPreference = getStoredVoiceAsrModelPreference(storedModelId);
          if (storedPreference.modelId) {
            nextModelId = storedPreference.modelId;
          } else if (storedPreference.shouldRemove) {
            await AsyncStorage.removeItem(VOICE_MODEL_STORAGE_KEY);
            if (!disposed && storedPreference.message) setVoiceMessage(storedPreference.message);
          }
        }
        const modelState = await getVoiceAsrModelState(nextModelId);
        if (disposed) return;
        setSelectedVoiceModelId(nextModelId);
        setVoiceModelState(modelState);
        if (modelState.status !== 'ready') setVoiceMessage(modelState.message);
      } catch (err) {
        if (!disposed) {
          setVoiceMessage(`Failed to inspect voice model: ${(err as Error).message}`);
        }
      }
    };
    void refreshVoiceConfiguration();
    return () => {
      disposed = true;
    };
  }, [selectedVoiceModelId]);

  useEffect(() => {
    if (!client) return;
    return client.subscribe(Events.CHAT_RESPONSE, (payload) => {
      const response = payload as ChatResponsePayload;
      if (response.sessionId !== SHARED_CHAT_SESSION_ID) return;
      if (response.state === 'delta') {
        if (response.statusText) setStreamingStatus(response.statusText);
        if (response.text) {
          setStreamingText((current) => current + response.text);
          setStreamingStatus('Streaming answer…');
        }
        return;
      }
      if (response.state === 'final') {
        setStreamingText('');
        setStreamingStatus('');
        setSending(false);
        if (response.message) {
          const finalMessage = response.message;
          setMessages((current) => [...current, finalMessage]);
        }
        scrollToBottom();
        return;
      }
      if (response.state === 'error') {
        setStreamingText('');
        setStreamingStatus('');
        setSending(false);
        setError(response.errorMessage ?? 'Co-Pilot response failed.');
        return;
      }
      if (response.state === 'aborted') {
        setStreamingText('');
        setStreamingStatus('');
        setSending(false);
      }
    });
  }, [client, scrollToBottom]);

  const sendPrompt = useCallback(
    async (promptText: string) => {
      const prompt = promptText.trim();
      if (!client || status !== 'connected' || !prompt || sending) return;
      setInput('');
      setSending(true);
      setError(null);
      setStreamingText('');
      setStreamingStatus('Working…');
      const optimisticMessage: ChatMessage = {
        id: `mobile-temp-${Date.now()}`,
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      };
      setMessages((current) => [...current, optimisticMessage]);
      scrollToBottom();
      try {
        await client.request(Methods.CHAT_SEND, {
          sessionId: SHARED_CHAT_SESSION_ID,
          message: prompt,
          clientContext: {
            surfaceId: 'mobile-copilot',
            route: 'companion:copilot',
            affordances: ['mobile', 'gateway-command', 'voice-ready'],
            visibleTextSnippets: [
              `${fleetSummary.slots} slots`,
              `${fleetSummary.activeRuns} active runs`,
              `${fleetSummary.pendingDecisions} pending decisions`,
            ],
          },
        });
      } catch (err) {
        setSending(false);
        setStreamingStatus('');
        setMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
        setError(`Failed to send Co-Pilot command: ${(err as Error).message}`);
      }
    },
    [
      client,
      fleetSummary.activeRuns,
      fleetSummary.pendingDecisions,
      fleetSummary.slots,
      scrollToBottom,
      sending,
      status,
    ],
  );

  const confirmAction = useCallback(
    async (action: ChatSuggestedAction) => {
      if (!client || !action.actionId || confirmingActionId) return;
      setConfirmingActionId(action.actionId);
      setError(null);
      try {
        const result = await client.request<ChatConfirmActionResult>(Methods.CHAT_CONFIRM_ACTION, {
          sessionId: SHARED_CHAT_SESSION_ID,
          actionId: action.actionId,
        });
        const systemMessage: ChatMessage = {
          id: `mobile-action-${result.actionId}-${Date.now()}`,
          role: 'system',
          content: `Confirmed ${result.type}: ${result.actionId}`,
          timestamp: new Date().toISOString(),
        };
        setMessages((current) => [...current, systemMessage]);
        scrollToBottom();
      } catch (err) {
        setError(`Failed to confirm action: ${(err as Error).message}`);
      } finally {
        setConfirmingActionId(null);
      }
    },
    [client, confirmingActionId, scrollToBottom],
  );

  const clearChat = useCallback(async () => {
    if (!client || status !== 'connected' || sending) return;
    setError(null);
    try {
      await client.request(Methods.CHAT_NEW, { sessionId: SHARED_CHAT_SESSION_ID });
      setMessages([]);
      setStreamingText('');
      setStreamingStatus('');
    } catch (err) {
      setError(`Failed to start new Co-Pilot chat: ${(err as Error).message}`);
    }
  }, [client, sending, status]);

  const saveIdea = useCallback(async () => {
    const body = input.trim();
    if (!client || status !== 'connected' || !body || savingIdea) return;
    setSavingIdea(true);
    setError(null);
    try {
      const result = await client.request<RoadmapSaveResult>(Methods.ROADMAP_SAVE, {
        item: {
          project: 'unassigned',
          title: ideaTitleFromBody(body),
          stage: 'rough',
          tags: ['companion-capture'],
          source: { kind: 'external', ref: 'companion' },
          body,
        },
      });
      setInput('');
      const systemMessage: ChatMessage = {
        id: `mobile-idea-${result.item.id}-${Date.now()}`,
        role: 'system',
        content: `Saved rough idea: ${result.item.title}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((current) => [...current, systemMessage]);
      scrollToBottom();
    } catch (err) {
      setError(`Failed to save roadmap idea: ${(err as Error).message}`);
    } finally {
      setSavingIdea(false);
    }
  }, [client, input, savingIdea, scrollToBottom, status]);

  const chatDisabled = status !== 'connected' || !client || sending;
  const ideaDisabled = status !== 'connected' || !client || savingIdea;
  const composerDisabled = composerMode === 'idea' ? ideaDisabled : chatDisabled;

  const startVoiceRecording = useCallback(async () => {
    if (voiceControlDisabled) return;
    if (voiceRuntimeReady !== true) {
      setVoiceStatus('error');
      setVoiceMessage(
        voiceRuntimeReady == null
          ? 'Checking Sherpa voice runtime. Try again in a moment.'
          : 'Sherpa voice runtime is unavailable. Rebuild the development app.',
      );
      return;
    }

    let modelState = voiceModelState;
    if (!modelState) {
      try {
        modelState = await getVoiceAsrModelState(selectedVoiceModelId);
        setVoiceModelState(modelState);
      } catch (err) {
        setVoiceStatus('error');
        setVoiceMessage(`Failed to inspect voice model: ${(err as Error).message}`);
        return;
      }
    }
    if (modelState.status !== 'ready') {
      setVoiceStatus('model_unavailable');
      setVoiceMessage(modelState.message);
      return;
    }

    setIsPreparingVoiceRecorder(true);
    setVoiceMessage('Preparing microphone…');
    setError(null);
    try {
      const permissionGate = await ensureMicrophonePermission();
      if (!permissionGate.granted) {
        setVoiceStatus('error');
        setVoiceMessage(permissionGate.message);
        if (permissionGate.blocked) promptOpenMicrophoneSettings(permissionGate.message);
        return;
      }
      await voiceRecorder.prepareRecording(VOICE_RECORDING_CONFIG);
      await voiceRecorder.startRecording(VOICE_RECORDING_CONFIG);
      setVoiceStatus('recording');
      setVoiceMessage('Listening… tap stop when finished.');
    } catch (err) {
      setVoiceStatus('error');
      setVoiceMessage(`Recording failed: ${(err as Error).message}`);
    } finally {
      setIsPreparingVoiceRecorder(false);
    }
  }, [
    selectedVoiceModelId,
    promptOpenMicrophoneSettings,
    voiceControlDisabled,
    voiceModelState,
    voiceRecorder,
    voiceRuntimeReady,
  ]);

  const stopVoiceRecording = useCallback(async () => {
    if (voiceStatus !== 'recording') return;
    setVoiceStatus('transcribing');
    setVoiceMessage('Transcribing on device…');
    try {
      const recording = await voiceRecorder.stopRecording();
      const result = await transcribeVoiceInstruction(recording, selectedVoiceModelId);
      setVoiceStatus(result.status);
      setVoiceMessage(result.message);
      if (result.status === 'transcript_ready') {
        setInput((current) => mergeVoiceTranscriptIntoInput(current, result.transcript));
      }
    } catch (err) {
      setVoiceStatus('error');
      setVoiceMessage(`Transcription failed: ${(err as Error).message}`);
    }
  }, [selectedVoiceModelId, voiceRecorder, voiceStatus]);

  const toggleVoiceRecording = useCallback(() => {
    if (voiceStatus === 'recording') {
      void stopVoiceRecording();
      return;
    }
    void startVoiceRecording();
  }, [startVoiceRecording, stopVoiceRecording, voiceStatus]);

  return (
    <KeyboardAvoidingView
      style={baseStyles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 92 : 0}
    >
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.eyebrow}>Gateway Co-Pilot</Text>
            <Text style={styles.title}>Command the fleet</Text>
          </View>
          <Pressable style={styles.clearButton} onPress={clearChat} disabled={chatDisabled}>
            <Text style={styles.clearButtonText}>New</Text>
          </Pressable>
        </View>
        <Text style={baseStyles.textSecondary}>
          Ask gateway intelligence to inspect state, summarize blockers, or propose safe actions.
        </Text>
        <View style={styles.metricRow}>
          <Metric label="Slots" value={String(fleetSummary.slots)} />
          <Metric label="Active" value={String(fleetSummary.activeRuns)} />
          <Metric label="Gates" value={String(fleetSummary.pendingDecisions)} />
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={[styles.messagesContent, { paddingBottom: spacing.lg }]}
        onContentSizeChange={scrollToBottom}
      >
        {messages.length === 0 && !streamingText ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No mobile commands yet</Text>
            <Text style={styles.emptyText}>
              Start with a quick prompt, type a command, or tap the mic to dictate.
            </Text>
          </View>
        ) : null}
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            confirmingActionId={confirmingActionId}
            onConfirmAction={confirmAction}
          />
        ))}
        {streamingText || streamingStatus ? (
          <View style={[styles.messageBubble, styles.assistantBubble]}>
            {streamingStatus ? <Text style={styles.streamingStatus}>{streamingStatus}</Text> : null}
            {streamingText ? <Text style={styles.messageText}>{streamingText}</Text> : null}
          </View>
        ) : null}
      </ScrollView>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={[styles.composer, { paddingBottom: insets.bottom + spacing.sm }]}>
        <View style={styles.modeToggle}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: composerMode === 'copilot' }}
            style={[styles.modeButton, composerMode === 'copilot' && styles.modeButtonActive]}
            onPress={() => setComposerMode('copilot')}
          >
            <Ionicons
              name="chatbubble-ellipses-outline"
              size={16}
              color={composerMode === 'copilot' ? '#fff' : colors.textSecondary}
            />
            <Text
              style={[
                styles.modeButtonText,
                composerMode === 'copilot' && styles.modeButtonTextActive,
              ]}
            >
              Co-Pilot
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: composerMode === 'idea' }}
            style={[styles.modeButton, composerMode === 'idea' && styles.modeButtonActive]}
            onPress={() => setComposerMode('idea')}
          >
            <Ionicons
              name="bulb-outline"
              size={16}
              color={composerMode === 'idea' ? '#fff' : colors.textSecondary}
            />
            <Text
              style={[
                styles.modeButtonText,
                composerMode === 'idea' && styles.modeButtonTextActive,
              ]}
            >
              Idea
            </Text>
          </Pressable>
        </View>
        {composerMode === 'copilot' ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.quickPromptRail}
          >
            {QUICK_PROMPTS.map((prompt) => (
              <Pressable
                key={prompt}
                style={[styles.quickPrompt, chatDisabled && styles.disabled]}
                disabled={chatDisabled}
                onPress={() => void sendPrompt(prompt)}
              >
                <Text style={styles.quickPromptText}>{prompt}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View
          style={styles.voiceComposerShell}
          onLayout={(event) => setVoicePanelWidth(event.nativeEvent.layout.width)}
        >
          {voiceStatus === 'recording' ? (
            <ChatRecordWidget
              state="recording"
              dataPoints={voiceWaveform}
              width={voiceWidgetWidth}
              waveformHeight={42}
              elapsedMs={voiceRecorder.durationMs}
              formatElapsed={formatVoiceElapsed}
              onStopPress={() => void stopVoiceRecording()}
              placeholderText="Listening…"
              amplitudeRange={SPEECH_AMPLITUDE_RANGE}
              barColor={colors.accent}
              silentBarColor={colors.bgCardHover}
              backgroundColor={colors.bgInput}
              accentColor={colors.statusFail}
              disabledColor={colors.bgCardHover}
              iconColor="#fff"
              textColor={colors.textPrimary}
              secondaryTextColor={colors.textMuted}
              caption="Tap stop to draft."
              captionColor={colors.textMuted}
              testID="copilot-voice-record-widget"
            />
          ) : (
            <View style={styles.inputRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dictate Co-Pilot command"
                accessibilityHint={voiceMessage || undefined}
                style={[styles.micButton, voiceBusy && styles.micButtonBusy]}
                disabled={voiceControlDisabled}
                onPress={toggleVoiceRecording}
              >
                <Ionicons
                  name={voiceControlDisabled ? 'ellipsis-horizontal' : 'mic-outline'}
                  size={20}
                  color="#fff"
                />
              </Pressable>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={
                  status === 'connected'
                    ? composerMode === 'idea'
                      ? 'Capture rough idea…'
                      : 'Ask gateway intelligence…'
                    : 'Connect first…'
                }
                placeholderTextColor={colors.textMuted}
                multiline
                editable={!composerDisabled && !voiceBusy}
                style={styles.input}
              />
              {input.trim() ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Reset Co-Pilot input"
                  style={[styles.resetInputButton, voiceBusy && styles.disabled]}
                  disabled={voiceBusy}
                  onPress={() => setInput('')}
                >
                  <Ionicons name="close" size={18} color={colors.textPrimary} />
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  composerMode === 'idea' ? 'Save rough roadmap idea' : 'Send Co-Pilot command'
                }
                style={[
                  styles.sendButton,
                  (!input.trim() || composerDisabled || voiceBusy) && styles.disabled,
                ]}
                disabled={!input.trim() || composerDisabled || voiceBusy}
                onPress={() => (composerMode === 'idea' ? void saveIdea() : void sendPrompt(input))}
              >
                <Ionicons
                  name={
                    savingIdea ? 'ellipsis-horizontal' : composerMode === 'idea' ? 'add' : 'send'
                  }
                  size={18}
                  color="#fff"
                />
              </Pressable>
            </View>
          )}
        </View>
        {voiceMessage && voiceStatus !== 'idle' ? (
          <Text style={styles.voiceStatusText} accessibilityLiveRegion="polite">
            {voiceMessage}
          </Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({
  message,
  confirmingActionId,
  onConfirmAction,
}: {
  message: ChatMessage;
  confirmingActionId: string | null;
  onConfirmAction: (action: ChatSuggestedAction) => void;
}) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  return (
    <View
      style={[
        styles.messageBubble,
        isUser ? styles.userBubble : isSystem ? styles.systemBubble : styles.assistantBubble,
      ]}
    >
      <Text style={styles.messageRole}>{isUser ? 'You' : isSystem ? 'System' : 'Gateway'}</Text>
      <Text style={styles.messageText}>{message.content}</Text>
      {message.suggestedActions?.length ? (
        <View style={styles.actionsBlock}>
          {message.suggestedActions.map((action) => (
            <View
              key={action.actionId ?? `${action.type}:${action.label}`}
              style={styles.actionCard}
            >
              <Text style={styles.actionLabel}>{action.label}</Text>
              <Text style={styles.actionMeta} numberOfLines={2}>
                {action.type} · {compactActionParams(action.params)}
              </Text>
              {action.actionId ? (
                <Pressable
                  style={[
                    styles.actionButton,
                    confirmingActionId === action.actionId && styles.disabled,
                  ]}
                  disabled={confirmingActionId === action.actionId}
                  onPress={() => onConfirmAction(action)}
                >
                  <Text style={styles.actionButtonText}>
                    {confirmingActionId === action.actionId ? 'Confirming…' : 'Confirm'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function compactActionParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params).slice(0, 3);
  if (entries.length === 0) return 'no params';
  return entries
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function ideaTitleFromBody(body: string): string {
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return `Companion idea ${new Date().toISOString().slice(0, 10)}`;
  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
}

function formatVoiceElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function takeVoiceLiveWindow(points: WaveformPoint[]): WaveformPoint[] {
  if (points.length >= VOICE_LIVE_BARS_WINDOW) {
    return points.slice(points.length - VOICE_LIVE_BARS_WINDOW);
  }
  return points;
}

function mergeVoiceTranscriptIntoInput(current: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) return current;
  const trimmedCurrent = current.trim();
  if (!trimmedCurrent) return trimmedTranscript;
  return `${trimmedCurrent}\n${trimmedTranscript}`;
}

const styles = StyleSheet.create({
  headerCard: {
    backgroundColor: colors.bgCard,
    borderBottomColor: colors.bgCardHover,
    borderBottomWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  eyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  clearButton: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  clearButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  metricRow: { flexDirection: 'row', gap: spacing.sm },
  metric: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    flex: 1,
    padding: spacing.md,
  },
  metricLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  metricValue: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900' },
  messages: { flex: 1 },
  messagesContent: { gap: spacing.md, padding: spacing.lg },
  emptyState: {
    alignItems: 'center',
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.xl,
  },
  emptyTitle: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900' },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  messageBubble: {
    borderRadius: radii.lg,
    gap: spacing.sm,
    padding: spacing.md,
  },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accent + '33', maxWidth: '88%' },
  assistantBubble: { alignSelf: 'stretch', backgroundColor: colors.bgCard },
  systemBubble: { alignSelf: 'stretch', backgroundColor: colors.bgInput },
  messageRole: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  messageText: { color: colors.textPrimary, fontSize: fonts.sizeSm, lineHeight: 20 },
  streamingStatus: { color: colors.accent, fontSize: fonts.sizeXs, fontWeight: '900' },
  actionsBlock: { gap: spacing.sm, marginTop: spacing.sm },
  actionCard: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '44',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  actionLabel: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '900' },
  actionMeta: { color: colors.textMuted, fontSize: fonts.sizeXs },
  actionButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actionButtonText: { color: '#fff', fontSize: fonts.sizeXs, fontWeight: '900' },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  composer: {
    backgroundColor: colors.bgSurface,
    borderTopColor: colors.bgCard,
    borderTopWidth: 1,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  modeToggle: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    padding: 3,
  },
  modeButton: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  modeButtonActive: { backgroundColor: colors.accent },
  modeButtonText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  modeButtonTextActive: { color: '#fff' },
  quickPromptRail: { flexGrow: 0 },
  quickPrompt: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    marginRight: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  quickPromptText: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '800' },
  inputRow: { alignItems: 'flex-end', flexDirection: 'row', gap: spacing.sm },
  voiceComposerShell: { width: '100%' },
  micButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCardHover,
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  micButtonBusy: { backgroundColor: colors.accent + '55' },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeSm,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 999,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  resetInputButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  voiceStatusText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  disabled: { opacity: 0.45 },
});
