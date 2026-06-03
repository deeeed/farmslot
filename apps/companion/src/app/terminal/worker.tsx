import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type RecordingConfig, useAudioRecorder } from '@siteed/audio-studio';
import {
  ChatRecordWidget,
  SPEECH_AMPLITUDE_RANGE,
  waveformBarsFromAudioStudioDataPoints,
  type WaveformPoint,
} from '@siteed/audio-ui';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Linking,
  Modal,
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
  type CopilotFormatInstructionResult,
  Methods,
  type TerminalData,
  type TerminalWorkerSnapshotResult,
  type TmuxWorkerNodeResult,
  type TmuxWorkerRef,
  type TmuxWorkerSummary,
} from '@farmslot/protocol';

import { TerminalControlKeyBar } from '../../components/TerminalControlKeyBar';
import { TerminalOrientationButton } from '../../components/TerminalOrientationButton';
import {
  type TerminalSize,
  XtermTerminalView,
  type XtermTerminalViewHandle,
} from '../../components/XtermTerminalView';
import { ensureMicrophonePermission } from '../../lib/audio-permissions';
import { useTerminalOrientationControls } from '../../lib/terminal-orientation';
import {
  appendTerminalTailText,
  terminalTailLinesFromText,
  trimTrailingTerminalBlankLines,
} from '../../lib/terminal-tail';
import { colors, fonts, radii, spacing } from '../../lib/theme';
import { tmuxWorkerRefFromRouteParams } from '../../lib/tmux-workers';
import {
  getConfiguredSherpaAsrModelId,
  getPreferredVoiceAsrModelId,
  getVoiceAsrModelState,
  getVoiceCopilotAvailability,
  getVoiceCopilotRuntimeState,
  resolveVoiceAsrModelPreference,
  transcribeVoiceInstruction,
  VOICE_MODEL_STORAGE_KEY,
  type VoiceAsrModelState,
  type VoiceCopilotStatus,
} from '../../lib/voice-copilot';
import {
  buildWorkerVoiceFormatRequest,
  workerVoiceInstructionInput,
} from '../../lib/worker-voice-nudge';
import { useConnectionStore } from '../../store/connection';
import { TMUX_PREFIX_BYTES, useTerminalPrefsStore } from '../../store/terminal-prefs';

const TERMINAL_DATA_EVENT = 'terminal.data';
const TERMINAL_TAIL_MAX_CHARS = 20_000;
const TERMINAL_WORKER_SNAPSHOT_LINES = 1000;
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatVoiceElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function takeVoiceLiveWindow(points: WaveformPoint[]): WaveformPoint[] {
  return points.slice(Math.max(0, points.length - VOICE_LIVE_BARS_WINDOW));
}

export default function WorkerTerminalScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const client = useConnectionStore((s) => s.client);
  const status = useConnectionStore((s) => s.status);
  const terminalRef = useRef<XtermTerminalViewHandle>(null);
  const terminalTailTextRef = useRef('');
  const voicePulse = useRef(new Animated.Value(0)).current;
  const voiceRecorder = useAudioRecorder();
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceCopilotStatus>('idle');
  const [voiceMessage, setVoiceMessage] = useState(getVoiceCopilotAvailability().message);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceDraft, setVoiceDraft] = useState('');
  const [voiceWarning, setVoiceWarning] = useState<string | null>(null);
  const [voiceRuntimeReady, setVoiceRuntimeReady] = useState<boolean | null>(null);
  const [voiceModelState, setVoiceModelState] = useState<VoiceAsrModelState | null>(null);
  const [selectedVoiceModelId, setSelectedVoiceModelId] = useState(getPreferredVoiceAsrModelId);
  const [isPreparingVoiceRecorder, setIsPreparingVoiceRecorder] = useState(false);
  const [isFormattingVoice, setIsFormattingVoice] = useState(false);
  const [voiceComposerOpen, setVoiceComposerOpen] = useState(false);
  const [voicePanelWidth, setVoicePanelWidth] = useState(0);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [showTmuxShortcuts, setShowTmuxShortcuts] = useState(false);
  const [windowPickerOpen, setWindowPickerOpen] = useState(false);
  const [windowPickerPanes, setWindowPickerPanes] = useState<TmuxWorkerSummary[]>([]);
  const [windowPickerError, setWindowPickerError] = useState<string | null>(null);
  const [windowPickerLoading, setWindowPickerLoading] = useState(false);
  const allowTerminalTouchKeyboard = useTerminalPrefsStore((s) => s.allowTerminalTouchKeyboard);
  const setAllowTerminalTouchKeyboard = useTerminalPrefsStore(
    (s) => s.setAllowTerminalTouchKeyboard,
  );
  const tmuxPrefixOption = useTerminalPrefsStore((s) => s.tmuxPrefix);
  const tmuxPrefix = TMUX_PREFIX_BYTES[tmuxPrefixOption];
  const orientationControls = useTerminalOrientationControls(terminalFullscreen);

  const workerRefParam = Array.isArray(params.workerRef) ? params.workerRef[0] : params.workerRef;
  const nodeIdParam = Array.isArray(params.nodeId) ? params.nodeId[0] : params.nodeId;
  const sessionParam = Array.isArray(params.session) ? params.session[0] : params.session;
  const targetParam = Array.isArray(params.target) ? params.target[0] : params.target;
  const windowParam = Array.isArray(params.window) ? params.window[0] : params.window;
  const windowNameParam = Array.isArray(params.windowName)
    ? params.windowName[0]
    : params.windowName;
  const paneParam = Array.isArray(params.pane) ? params.pane[0] : params.pane;
  const paneIdParam = Array.isArray(params.paneId) ? params.paneId[0] : params.paneId;
  const titleParam = Array.isArray(params.title) ? params.title[0] : params.title;

  const worker = useMemo(
    (): TmuxWorkerRef | null =>
      tmuxWorkerRefFromRouteParams({
        workerRef: workerRefParam,
        nodeId: nodeIdParam,
        session: sessionParam,
        target: targetParam,
        window: windowParam,
        windowName: windowNameParam,
        pane: paneParam,
        paneId: paneIdParam,
      }),
    [
      nodeIdParam,
      paneIdParam,
      paneParam,
      sessionParam,
      targetParam,
      windowNameParam,
      windowParam,
      workerRefParam,
    ],
  );

  const title = titleParam || worker?.target || 'Worker terminal';
  const connectionReady = status === 'connected' && Boolean(client);
  const workerReady = connectionReady && Boolean(worker);
  const hasVoiceDraft = voiceDraft.trim().length > 0;
  const voiceEditableInstruction = hasVoiceDraft ? voiceDraft : voiceTranscript;
  const hasVoiceEditableInstruction = voiceEditableInstruction.trim().length > 0;
  const voiceModelNeedsSetup = Boolean(voiceModelState && voiceModelState.status !== 'ready');
  const voiceRuntimePending = voiceRuntimeReady === null;
  const voiceBusy = isPreparingVoiceRecorder || voiceStatus === 'transcribing' || isFormattingVoice;
  const voiceInputLocked = voiceStatus === 'transcribing' || isFormattingVoice;
  const showVoiceComposer =
    voiceComposerOpen ||
    voiceStatus !== 'idle' ||
    hasVoiceEditableInstruction ||
    isPreparingVoiceRecorder ||
    isFormattingVoice;
  const showFloatingVoiceButton = !showVoiceComposer && !voiceBusy;
  const animateVoiceButton =
    voiceStatus === 'recording' ||
    voiceStatus === 'transcribing' ||
    isPreparingVoiceRecorder ||
    isFormattingVoice;
  const voiceWidgetWidth = Math.max(1, voicePanelWidth - spacing.md * 2);
  const voiceWaveform = useMemo<WaveformPoint[]>(() => {
    const dataPoints = voiceRecorder.analysisData?.dataPoints ?? [];
    return takeVoiceLiveWindow(
      waveformBarsFromAudioStudioDataPoints(
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
      ),
    );
  }, [voiceRecorder.analysisData?.dataPoints]);
  const voiceButtonPulseStyle = {
    opacity: voicePulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.48] }),
    transform: [{ scale: voicePulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }) }],
  };

  const appendTerminalTail = useCallback((chunk: string) => {
    terminalTailTextRef.current = appendTerminalTailText(
      terminalTailTextRef.current,
      chunk,
      TERMINAL_TAIL_MAX_CHARS,
    );
  }, []);

  const loadSnapshot = useCallback(async () => {
    if (!client || status !== 'connected' || !worker) return;
    try {
      const result = await client.request<TerminalWorkerSnapshotResult>(
        Methods.TERMINAL_WORKER_SNAPSHOT,
        { worker, lines: TERMINAL_WORKER_SNAPSHOT_LINES },
        10_000,
      );
      const visibleLines = trimTrailingTerminalBlankLines(result.lines);
      const text = visibleLines.join('\r\n');
      setLines(visibleLines);
      terminalTailTextRef.current = visibleLines.join('\n');
      terminalRef.current?.reset(text);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, status, worker]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (!client || status !== 'connected' || !worker) return;
    let mounted = true;
    const matches = (data: TerminalData) =>
      data.worker?.nodeId === worker.nodeId && data.worker?.target === worker.target;
    const unsub = client.subscribe(TERMINAL_DATA_EVENT, (payload) => {
      const data = payload as TerminalData;
      if (!mounted || !matches(data)) return;
      terminalRef.current?.write(data.data);
      appendTerminalTail(data.data);
      setError(null);
    });
    client
      .request(Methods.TERMINAL_WORKER_SUBSCRIBE, { worker }, 10_000)
      .then(() => {
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      mounted = false;
      unsub();
      client.request(Methods.TERMINAL_WORKER_UNSUBSCRIBE, { worker }, 5_000).catch((err: Error) => {
        // Unsubscribe can race with tmux pane teardown; after unmount there is no visible
        // worker terminal state to update, and socket cleanup releases handlers too.
        console.warn(`[terminal-worker] unsubscribe failed for ${worker.target}: ${err.message}`);
      });
    };
  }, [appendTerminalTail, client, status, worker]);

  useEffect(() => {
    let disposed = false;
    getVoiceCopilotRuntimeState()
      .then((state) => {
        if (disposed) return;
        setVoiceRuntimeReady(state.available);
        if (!state.available) {
          setVoiceWarning(state.message);
          setVoiceMessage(state.message);
        }
      })
      .catch((err: Error) => {
        if (disposed) return;
        setVoiceRuntimeReady(false);
        setVoiceWarning(`Sherpa native runtime check failed: ${err.message}`);
        setVoiceMessage('Sherpa native runtime check failed. Rebuild the development app.');
      });
    return () => {
      disposed = true;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      let disposed = false;
      const refreshFocusedVoiceConfiguration = async () => {
        try {
          const configuredModelId = getConfiguredSherpaAsrModelId();
          const storedModelId = await AsyncStorage.getItem(VOICE_MODEL_STORAGE_KEY);
          const preference = resolveVoiceAsrModelPreference({
            configuredModelId,
            storedModelId,
            currentModelId: selectedVoiceModelId,
          });
          if (preference.shouldRemoveStoredPreference) {
            await AsyncStorage.removeItem(VOICE_MODEL_STORAGE_KEY);
            if (!disposed) setVoiceWarning(preference.message);
          }
          const state = await getVoiceAsrModelState(preference.modelId);
          if (disposed) return;
          setSelectedVoiceModelId(preference.modelId);
          setVoiceModelState(state);
        } catch (err) {
          if (!disposed)
            setVoiceWarning(`Failed to refresh voice ASR configuration: ${getErrorMessage(err)}`);
        }
      };
      void refreshFocusedVoiceConfiguration();
      return () => {
        disposed = true;
      };
    }, [selectedVoiceModelId]),
  );

  useEffect(() => {
    if (!animateVoiceButton) {
      voicePulse.stopAnimation();
      voicePulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(voicePulse, {
          toValue: 1,
          duration: 650,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(voicePulse, {
          toValue: 0,
          duration: 650,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [animateVoiceButton, voicePulse]);

  const sendInput = useCallback(
    (data: string) => {
      if (!client || !worker) return;
      client
        .request(Methods.TERMINAL_WORKER_INPUT, { worker, data }, 10_000)
        .catch((err: Error) => {
          setError(err.message);
        });
    },
    [client, worker],
  );

  const openWindowPicker = useCallback(async () => {
    if (!client || !worker) return;
    setWindowPickerOpen(true);
    setWindowPickerLoading(true);
    setWindowPickerError(null);
    try {
      const result = await client.request<{ nodes: TmuxWorkerNodeResult[] }>(
        Methods.TMUX_WORKER_LIST,
        { includeDisconnected: false },
        10_000,
      );
      const node = result.nodes.find((entry) => entry.nodeId === worker.nodeId);
      const panes = node?.ok
        ? node.workers.filter((pane) => pane.ref.session === worker.session)
        : [];
      setWindowPickerPanes(panes);
      if (!node?.ok) {
        setWindowPickerError(node?.error ?? 'Node returned no tmux data.');
      } else if (panes.length === 0) {
        setWindowPickerError('No windows found for this session.');
      }
    } catch (err) {
      setWindowPickerError(err instanceof Error ? err.message : String(err));
      setWindowPickerPanes([]);
    } finally {
      setWindowPickerLoading(false);
    }
  }, [client, worker]);

  const selectWindow = useCallback(
    (windowIndex: string) => {
      // tmux `prefix + <0-9>` selects window N. Multi-digit indexes fall back
      // to `prefix + '` which prompts tmux for a window number, terminated by
      // Enter — keeps the picker working on sessions with >9 windows.
      const trimmed = windowIndex.trim();
      const data =
        trimmed.length === 1 && /^[0-9]$/u.test(trimmed)
          ? `${tmuxPrefix}${trimmed}`
          : `${tmuxPrefix}'${trimmed}\r`;
      sendInput(data);
      setWindowPickerOpen(false);
    },
    [sendInput, tmuxPrefix],
  );

  const sendReviewedVoiceInstruction = useCallback(async (): Promise<boolean> => {
    const data = workerVoiceInstructionInput(voiceEditableInstruction);
    if (!data || !client || !worker || isSending) return false;
    setIsSending(true);
    try {
      await client.request(Methods.TERMINAL_WORKER_INPUT, { worker, data }, 10_000);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setVoiceStatus('idle');
      setVoiceMessage('Instruction sent. Tap mic for the next worker nudge.');
      setVoiceTranscript('');
      setVoiceDraft('');
      setVoiceWarning(null);
      setVoiceComposerOpen(false);
      return true;
    } catch (err) {
      setVoiceWarning(`Send failed: ${getErrorMessage(err)}`);
      return false;
    } finally {
      setIsSending(false);
    }
  }, [client, isSending, voiceEditableInstruction, worker]);

  const resize = useCallback(
    (size: TerminalSize) => {
      if (!client || !worker) return;
      client
        .request(
          Methods.TERMINAL_WORKER_RESIZE,
          { worker, cols: size.cols, rows: size.rows },
          10_000,
        )
        .catch((err: Error) => setError(err.message));
    },
    [client, worker],
  );

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

  const openVoiceSettings = useCallback(() => router.push('/settings'), [router]);

  const startVoiceRecording = useCallback(async () => {
    if (isPreparingVoiceRecorder) return;
    setVoiceComposerOpen(true);
    if (voiceRuntimeReady !== true || voiceModelNeedsSetup) {
      setVoiceStatus('idle');
      setVoiceWarning(
        voiceRuntimePending
          ? 'Waiting for voice runtime check. You can type the nudge now.'
          : voiceModelNeedsSetup
            ? 'Download a transcription model in Settings, or type the nudge now.'
            : 'Voice runtime is unavailable. Rebuild the development app or type the nudge now.',
      );
      return;
    }
    setIsPreparingVoiceRecorder(true);
    setVoiceWarning(null);
    try {
      setVoiceMessage('Preparing microphone access…');
      const permissionGate = await ensureMicrophonePermission();
      if (!permissionGate.granted) {
        setVoiceStatus('error');
        setVoiceMessage(permissionGate.message);
        setVoiceWarning(permissionGate.message);
        if (permissionGate.blocked) promptOpenMicrophoneSettings(permissionGate.message);
        return;
      }
      await voiceRecorder.prepareRecording(VOICE_RECORDING_CONFIG);
      setVoiceMessage('Recording worker nudge. Tap stop when finished.');
      await voiceRecorder.startRecording(VOICE_RECORDING_CONFIG);
      setVoiceTranscript('');
      setVoiceDraft('');
      setVoiceStatus('recording');
    } catch (err) {
      setVoiceStatus('error');
      setVoiceMessage(`Recording failed: ${getErrorMessage(err)}`);
      setVoiceWarning(`Check microphone permission. ${getErrorMessage(err)}`);
    } finally {
      setIsPreparingVoiceRecorder(false);
    }
  }, [
    isPreparingVoiceRecorder,
    promptOpenMicrophoneSettings,
    voiceModelNeedsSetup,
    voiceRecorder,
    voiceRuntimePending,
    voiceRuntimeReady,
  ]);

  const stopVoiceRecording = useCallback(async () => {
    setVoiceStatus('transcribing');
    setVoiceWarning(null);
    try {
      const recording = await voiceRecorder.stopRecording();
      const result = await transcribeVoiceInstruction(recording, selectedVoiceModelId);
      setVoiceStatus(result.status);
      setVoiceMessage(result.message);
      setVoiceTranscript(result.transcript);
      setVoiceDraft('');
      setVoiceComposerOpen(true);
      if (result.status === 'model_unavailable') {
        setVoiceWarning('Type the nudge manually until an on-device ASR model is configured.');
      }
    } catch (err) {
      setVoiceStatus('error');
      setVoiceMessage(`Transcription failed: ${getErrorMessage(err)}`);
    }
  }, [selectedVoiceModelId, voiceRecorder]);

  const formatVoiceDraft = useCallback(async () => {
    const transcript = voiceEditableInstruction.trim();
    if (!transcript || !client || !worker || status !== 'connected' || isFormattingVoice) return;
    setIsFormattingVoice(true);
    setVoiceWarning(null);
    setVoiceMessage('Formatting through gateway intelligence. Review before sending.');
    try {
      const result = await client.request<CopilotFormatInstructionResult>(
        Methods.COPILOT_FORMAT_INSTRUCTION,
        buildWorkerVoiceFormatRequest({
          transcript,
          worker,
          terminalTail: terminalTailLinesFromText(terminalTailTextRef.current, 20),
        }),
        30_000,
      );
      const draft = result.draftText?.trim();
      if (!draft) {
        setVoiceWarning('copilot.formatInstruction returned no draft text.');
        return;
      }
      setVoiceDraft(draft);
      setVoiceStatus('transcript_ready');
      setVoiceMessage('Draft formatted. Review, edit, then tap Send.');
      setVoiceWarning(result.warnings?.filter(Boolean).join(' ') || null);
    } catch (err) {
      setVoiceWarning(`Format failed via copilot.formatInstruction: ${getErrorMessage(err)}`);
    } finally {
      setIsFormattingVoice(false);
    }
  }, [client, isFormattingVoice, status, voiceEditableInstruction, worker]);

  const handleVoicePress = useCallback(() => {
    if (voiceStatus === 'recording') {
      void stopVoiceRecording();
      return;
    }
    if (voiceBusy) return;
    void startVoiceRecording();
  }, [startVoiceRecording, stopVoiceRecording, voiceBusy, voiceStatus]);

  const discardVoiceDraft = useCallback(() => {
    setVoiceStatus('idle');
    setVoiceMessage('Draft discarded. Tap mic to dictate again.');
    setVoiceTranscript('');
    setVoiceDraft('');
    setVoiceWarning(null);
    setVoiceComposerOpen(false);
  }, []);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
      style={styles.container}
    >
      <StatusBar hidden={terminalFullscreen} style="light" />
      <View style={[styles.content, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {terminalFullscreen ? (
          <View style={[styles.fullscreenOverlay, { top: insets.top + spacing.xs }]}>
            <Pressable style={styles.fullscreenBackButton} onPress={() => router.back()}>
              <Text style={styles.fullscreenBackText}>‹</Text>
            </Pressable>
            <View style={styles.titleBlock}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {worker ? `${worker.nodeId} · ${worker.target}` : 'Missing worker target'}
              </Text>
            </View>
            <Pressable
              style={[styles.fullscreenPill, showTmuxShortcuts && styles.tmuxToggleActive]}
              onPress={() => setShowTmuxShortcuts((current) => !current)}
            >
              <Text
                style={[
                  styles.fullscreenPillText,
                  showTmuxShortcuts && styles.tmuxToggleTextActive,
                ]}
              >
                Tmux
              </Text>
            </Pressable>
            <TerminalOrientationButton controls={orientationControls} />
            <Pressable style={styles.fullscreenPill} onPress={() => setTerminalFullscreen(false)}>
              <Text style={styles.fullscreenPillText}>Exit</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.header}>
            <Pressable style={styles.headerButton} onPress={() => router.back()}>
              <Ionicons name="chevron-back" size={18} color={colors.accent} />
              <Text style={styles.headerButtonText}>Back</Text>
            </Pressable>
            <View style={styles.titleBlock}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {worker ? `${worker.nodeId} · ${worker.target}` : 'Missing worker target'}
              </Text>
            </View>
            <Pressable
              style={[styles.headerPill, showTmuxShortcuts && styles.tmuxToggleActive]}
              onPress={() => setShowTmuxShortcuts((current) => !current)}
            >
              <Text
                style={[styles.headerPillText, showTmuxShortcuts && styles.tmuxToggleTextActive]}
              >
                Tmux
              </Text>
            </Pressable>
            <Pressable style={styles.headerButton} onPress={() => void loadSnapshot()}>
              <Ionicons name="refresh" size={18} color={colors.accent} />
            </Pressable>
            <Pressable style={styles.headerButton} onPress={() => setTerminalFullscreen(true)}>
              <Ionicons name="expand-outline" size={18} color={colors.accent} />
            </Pressable>
          </View>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.terminalArea}>
          <XtermTerminalView
            ref={terminalRef}
            allowTouchKeyboard={allowTerminalTouchKeyboard}
            initialText={lines.join('\r\n')}
            onInput={sendInput}
            onResize={resize}
            readOnlyReason={
              !worker ? 'Missing worker target' : status !== 'connected' ? 'Not connected' : null
            }
          />
        </View>
        {showVoiceComposer ? (
          <View
            style={styles.voicePanel}
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
                caption="Tap stop when finished."
                captionColor={colors.textMuted}
                testID="worker-voice-record-widget"
              />
            ) : (
              <View style={styles.voiceComposerRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dictate worker nudge"
                  accessibilityHint={voiceMessage || undefined}
                  style={[styles.voiceMicButton, voiceBusy && styles.disabledButton]}
                  onPress={handleVoicePress}
                  disabled={voiceBusy}
                >
                  <Ionicons
                    name={voiceBusy ? 'ellipsis-horizontal' : 'mic-outline'}
                    size={20}
                    color="#fff"
                  />
                </Pressable>
                <View style={styles.voiceInputSurface}>
                  <TextInput
                    style={[styles.voiceTextInput, voiceInputLocked && styles.voiceTextInputLocked]}
                    value={voiceEditableInstruction}
                    onChangeText={(text) => {
                      if (hasVoiceDraft) {
                        setVoiceDraft(text);
                      } else {
                        setVoiceTranscript(text);
                      }
                      setVoiceWarning(null);
                    }}
                    placeholder={
                      voiceRuntimePending
                        ? 'Checking voice… type nudge…'
                        : voiceModelNeedsSetup
                          ? 'Download ASR, or type nudge…'
                          : 'Say or type worker nudge…'
                    }
                    placeholderTextColor={colors.textMuted}
                    multiline
                    autoCapitalize="sentences"
                    editable={!voiceInputLocked}
                  />
                </View>
                <View style={styles.voiceActionStack}>
                  {hasVoiceEditableInstruction ? (
                    <>
                      <Pressable
                        style={[
                          styles.voiceSmallButton,
                          (!workerReady || isFormattingVoice) && styles.disabledButton,
                        ]}
                        onPress={() => void formatVoiceDraft()}
                        disabled={!workerReady || isFormattingVoice}
                      >
                        <Text style={styles.voiceSmallButtonText}>
                          {isFormattingVoice ? '…' : 'Format'}
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.voiceSendButton,
                          (!connectionReady || isSending || voiceInputLocked) &&
                            styles.disabledButton,
                        ]}
                        onPress={() => void sendReviewedVoiceInstruction()}
                        disabled={!workerReady || isSending || voiceInputLocked}
                      >
                        <Text style={styles.voiceSendText}>{isSending ? '…' : 'Send'}</Text>
                      </Pressable>
                      <Pressable style={styles.voiceCancelButton} onPress={discardVoiceDraft}>
                        <Text style={styles.voiceCancelText}>Cancel</Text>
                      </Pressable>
                    </>
                  ) : voiceModelNeedsSetup ? (
                    <Pressable style={styles.voiceSmallButton} onPress={openVoiceSettings}>
                      <Text style={styles.voiceSmallButtonText}>Settings</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            )}
            {voiceBusy && voiceMessage ? (
              <Text style={styles.voiceProgressText}>{voiceMessage}</Text>
            ) : null}
            {voiceWarning ? <Text style={styles.voiceWarningText}>{voiceWarning}</Text> : null}
          </View>
        ) : null}
        {showTmuxShortcuts ? (
          <WorkerTmuxShortcutPanel
            disabled={!workerReady}
            onSend={sendInput}
            tmuxPrefix={tmuxPrefix}
            onOpenWindowPicker={() => void openWindowPicker()}
          />
        ) : null}
        <WindowPickerModal
          visible={windowPickerOpen}
          loading={windowPickerLoading}
          error={windowPickerError}
          panes={windowPickerPanes}
          currentWindow={worker?.window}
          onClose={() => setWindowPickerOpen(false)}
          onSelect={selectWindow}
        />
        <View style={styles.keyBar}>
          <TerminalControlKeyBar
            label={null}
            touchKeyboardEnabled={allowTerminalTouchKeyboard}
            onPress={(control) => sendInput(control.data)}
            onToggleTouchKeyboard={() => setAllowTerminalTouchKeyboard(!allowTerminalTouchKeyboard)}
          />
        </View>
        {showFloatingVoiceButton ? (
          <Animated.View style={[styles.floatingVoiceShell, { bottom: insets.bottom + 56 }]}>
            {animateVoiceButton ? (
              <Animated.View style={[styles.floatingVoicePulse, voiceButtonPulseStyle]} />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dictate worker nudge"
              accessibilityHint={voiceMessage || undefined}
              style={styles.floatingVoiceButton}
              onPress={() => {
                setVoiceComposerOpen(true);
                void startVoiceRecording();
              }}
            >
              <Ionicons name="mic-outline" size={24} color="#fff" />
            </Pressable>
          </Animated.View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function WorkerTmuxShortcutPanel({
  disabled,
  onSend,
  tmuxPrefix,
  onOpenWindowPicker,
}: {
  disabled: boolean;
  onSend: (data: string) => void;
  tmuxPrefix: string;
  onOpenWindowPicker: () => void;
}) {
  const send = (label: string, sequence: string, danger = false) => (
    <Pressable
      key={label}
      style={[
        styles.tmuxShortcutButton,
        danger && styles.tmuxShortcutDanger,
        disabled && styles.disabledButton,
      ]}
      disabled={disabled}
      onPress={() => onSend(sequence)}
    >
      <Text style={[styles.tmuxShortcutText, danger && styles.tmuxShortcutDangerText]}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.tmuxShortcutPanel}>
      <Text style={styles.tmuxShortcutTitle}>Tmux controls</Text>
      <View style={styles.tmuxShortcutRow}>
        {send('Split →', `${tmuxPrefix}%`)}
        {send('Split ↓', `${tmuxPrefix}"`)}
        {send('New win', `${tmuxPrefix}c`)}
        {send('Prev win', `${tmuxPrefix}p`)}
        {send('Next win', `${tmuxPrefix}n`)}
        <Pressable
          key="Pick win"
          style={[styles.tmuxShortcutButton, disabled && styles.disabledButton]}
          disabled={disabled}
          onPress={onOpenWindowPicker}
        >
          <Text style={styles.tmuxShortcutText}>Pick win</Text>
        </Pressable>
        {send('Windows', `${tmuxPrefix}w`)}
        {send('Zoom', `${tmuxPrefix}z`)}
        {send('Prefix', tmuxPrefix)}
        {send('Kill pane', `${tmuxPrefix}x`, true)}
      </View>
    </View>
  );
}

type WindowPickerEntry = {
  window: string;
  windowName?: string;
  paneCount: number;
  active: boolean;
};

function buildWindowPickerEntries(
  panes: TmuxWorkerSummary[],
  currentWindow: string | undefined,
): WindowPickerEntry[] {
  const order: string[] = [];
  const byWindow = new Map<string, WindowPickerEntry>();
  for (const pane of panes) {
    const window = pane.ref.window ?? '0';
    let entry = byWindow.get(window);
    if (!entry) {
      entry = {
        window,
        ...(pane.ref.windowName ? { windowName: pane.ref.windowName } : {}),
        paneCount: 0,
        active: false,
      };
      byWindow.set(window, entry);
      order.push(window);
    }
    entry.paneCount += 1;
    if (currentWindow && window === currentWindow) entry.active = true;
  }
  return order.map((window) => byWindow.get(window)!);
}

function WindowPickerModal({
  visible,
  loading,
  error,
  panes,
  currentWindow,
  onClose,
  onSelect,
}: {
  visible: boolean;
  loading: boolean;
  error: string | null;
  panes: TmuxWorkerSummary[];
  currentWindow: string | undefined;
  onClose: () => void;
  onSelect: (windowIndex: string) => void;
}) {
  const entries = buildWindowPickerEntries(panes, currentWindow);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.windowPickerBackdrop} onPress={onClose}>
        <Pressable style={styles.windowPickerCard} onPress={(event) => event.stopPropagation()}>
          <View style={styles.windowPickerHeader}>
            <Text style={styles.windowPickerTitle}>Switch window</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.windowPickerClose}>Close</Text>
            </Pressable>
          </View>
          {loading ? <Text style={styles.windowPickerMuted}>Loading…</Text> : null}
          {error ? <Text style={styles.windowPickerError}>{error}</Text> : null}
          {!loading && entries.length > 0 ? (
            <ScrollView style={styles.windowPickerList}>
              {entries.map((entry) => (
                <Pressable
                  key={entry.window}
                  style={[styles.windowPickerItem, entry.active && styles.windowPickerItemActive]}
                  onPress={() => onSelect(entry.window)}
                >
                  <Text style={styles.windowPickerItemTitle} numberOfLines={1}>
                    {entry.windowName ? `${entry.window} · ${entry.windowName}` : `${entry.window}`}
                  </Text>
                  <Text style={styles.windowPickerItemMeta}>
                    {entry.paneCount} pane{entry.paneCount === 1 ? '' : 's'}
                    {entry.active ? ' · current' : ''}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#000', flex: 1 },
  content: { backgroundColor: '#000', flex: 1 },
  header: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  headerButton: { alignItems: 'center', flexDirection: 'row', minWidth: 48 },
  headerButtonText: { color: colors.accent, fontWeight: '600', fontSize: 13 },
  headerPill: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  headerPillText: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '900' },
  tmuxToggleActive: { borderColor: colors.accent, backgroundColor: colors.accent + '22' },
  tmuxToggleTextActive: { color: colors.accent },
  titleBlock: { flex: 1 },
  title: { color: colors.textPrimary, fontWeight: '600', fontSize: 15 },
  subtitle: { color: colors.textMuted, fontFamily: fonts.mono, fontSize: 11 },
  fullscreenOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(10, 10, 15, 0.78)',
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    left: spacing.sm,
    padding: spacing.xs,
    position: 'absolute',
    right: spacing.sm,
    zIndex: 20,
  },
  fullscreenBackButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 999,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  fullscreenBackText: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '800',
    lineHeight: 26,
  },
  fullscreenPill: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  fullscreenPillText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  error: {
    backgroundColor: colors.statusFail + '22',
    color: colors.statusFail,
    padding: spacing.sm,
  },
  terminalArea: { flex: 1 },
  voicePanel: {
    backgroundColor: colors.bgSurface,
    borderTopColor: colors.bgCard,
    borderTopWidth: 1,
    padding: spacing.sm,
  },
  voiceComposerRow: { alignItems: 'stretch', flexDirection: 'row', gap: spacing.sm },
  voiceMicButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.accent,
    borderRadius: radii.lg,
    justifyContent: 'center',
    minWidth: 42,
  },
  voiceInputSurface: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    flex: 1,
    minHeight: 48,
  },
  voiceTextInput: {
    color: colors.textPrimary,
    fontSize: 13,
    maxHeight: 104,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  voiceTextInputLocked: { opacity: 0.7 },
  voiceActionStack: { gap: spacing.xs, justifyContent: 'center', width: 72 },
  voiceSmallButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  voiceSmallButtonText: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  voiceSendButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  voiceSendText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  voiceCancelButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  voiceCancelText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  voiceProgressText: { color: colors.textMuted, fontSize: 11, marginTop: spacing.xs },
  voiceWarningText: { color: colors.statusWarn, fontSize: 11, marginTop: spacing.xs },
  tmuxShortcutPanel: {
    backgroundColor: colors.bgSurface,
    borderTopColor: colors.bgCard,
    borderTopWidth: 1,
    gap: spacing.xs,
    padding: spacing.sm,
  },
  tmuxShortcutTitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  tmuxShortcutRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tmuxShortcutButton: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  tmuxShortcutDanger: {
    backgroundColor: colors.statusFail + '18',
    borderColor: colors.statusFail + '77',
  },
  tmuxShortcutText: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '900' },
  tmuxShortcutDangerText: { color: colors.statusFail },
  keyBar: {
    backgroundColor: colors.bgSurface,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    padding: spacing.sm,
  },
  floatingVoiceShell: { position: 'absolute', right: spacing.lg },
  floatingVoicePulse: {
    backgroundColor: colors.accent,
    borderRadius: 24,
    height: 48,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 48,
  },
  floatingVoiceButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  disabledButton: { opacity: 0.5 },
  windowPickerBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  windowPickerCard: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    maxHeight: '70%',
    padding: spacing.md,
    width: '100%',
  },
  windowPickerHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  windowPickerTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  windowPickerClose: {
    color: colors.accent,
    fontSize: 13,
  },
  windowPickerMuted: {
    color: colors.textMuted,
    padding: spacing.sm,
    textAlign: 'center',
  },
  windowPickerError: {
    color: colors.statusFail,
    padding: spacing.sm,
    textAlign: 'center',
  },
  windowPickerList: {
    marginTop: spacing.xs,
  },
  windowPickerItem: {
    backgroundColor: colors.bgBase,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.xs,
    padding: spacing.md,
  },
  windowPickerItemActive: {
    borderColor: colors.statusOk,
  },
  windowPickerItemTitle: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '600',
  },
  windowPickerItemMeta: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
  },
});
