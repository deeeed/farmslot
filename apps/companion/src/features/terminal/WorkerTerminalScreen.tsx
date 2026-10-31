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
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
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
  type TmuxWorkerListResult,
  type TmuxWorkerRef,
  type TmuxWorkerSummary,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { TerminalControlKeyBar } from '../../components/TerminalControlKeyBar';
import { TerminalHeldInput } from '../../components/TerminalHeldInput';
import {
  TerminalInputLine,
  type TerminalInputLineHandle,
} from '../../components/TerminalInputLine';
import { TerminalOrientationButton } from '../../components/TerminalOrientationButton';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { ensureMicrophonePermission } from '../../lib/audio-permissions';
import { usePersistentFlag } from '../../lib/held-connection';
import { quickVoiceInstruction, quickVoiceWorkerKey } from '../../lib/quick-actions';
import { getResourceCache } from '../../lib/resource-cache';
import { savedForDisplay, visibleReadError } from '../../lib/resource-read-status';
import {
  type HeldTerminalInput,
  keysRetryingNotice,
  TerminalInputCancelledError,
  withoutKeysRetryingNotice,
} from '../../lib/terminal-input-queue';
import { useTerminalOrientationControls } from '../../lib/terminal-orientation';
import {
  appendTerminalTailText,
  terminalTailLinesFromText,
  trimTrailingTerminalBlankLines,
} from '../../lib/terminal-tail';
import { colors, spacing } from '../../lib/theme';
import { inventoryLacksPane, tmuxWorkerRefFromRouteParams } from '../../lib/tmux-workers';
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
import { heldConnectionCurrent, useHeldConnection } from '../../store/held-connection';
import { TMUX_PREFIX_BYTES, useTerminalPrefsStore } from '../../store/terminal-prefs';
import {
  useQuickActionVoiceTarget,
  useSharedViewSelection,
} from '../quick-actions/QuickActionsProvider';
import { useQuickActionComposerInset } from '../quick-actions/use-quick-action-composer-inset';

import {
  TerminalModeToggle,
  type TerminalSize,
  type TerminalViewMode,
  TerminalViewSurface,
  type XtermTerminalViewHandle,
} from './components/terminal-history-viewer';
import { WindowPickerModal, WorkerTmuxShortcutPanel } from './components/worker-terminal-panels';
import { workerTerminalStyles as styles } from './styles/worker-terminal.styles';
import { useWorkerTerminalInput } from './use-worker-terminal-input';

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
  const draftParam = (Array.isArray(params.draft) ? params.draft[0] : params.draft)?.trim() ?? '';
  const focused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const status = useConnectionStore((s) => s.status);
  const terminalRef = useRef<XtermTerminalViewHandle>(null);
  const terminalTailTextRef = useRef('');
  const voiceRecorder = useAudioRecorder();
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceCopilotStatus>('idle');
  const [voiceMessage, setVoiceMessage] = useState(getVoiceCopilotAvailability().message);
  const [voiceTranscript, setVoiceTranscript] = useState(draftParam);
  const [voiceDraft, setVoiceDraft] = useState('');
  const [voiceContext, setVoiceContext] = useState('');
  const [voiceWarning, setVoiceWarning] = useState<string | null>(null);
  const [voiceRuntimeReady, setVoiceRuntimeReady] = useState<boolean | null>(null);
  const [voiceModelState, setVoiceModelState] = useState<VoiceAsrModelState | null>(null);
  const [selectedVoiceModelId, setSelectedVoiceModelId] = useState(getPreferredVoiceAsrModelId);
  const [isPreparingVoiceRecorder, setIsPreparingVoiceRecorder] = useState(false);
  const [isFormattingVoice, setIsFormattingVoice] = useState(false);
  const [voiceComposerOpen, setVoiceComposerOpen] = useState(Boolean(draftParam));
  const [voicePanelWidth, setVoicePanelWidth] = useState(0);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [showTmuxShortcuts, setShowTmuxShortcuts] = useState(false);
  const [terminalViewMode, setTerminalViewMode] = useState<TerminalViewMode>('tmux');
  const [windowPickerOpen, setWindowPickerOpen] = useState(false);
  const [windowPickerPanes, setWindowPickerPanes] = useState<TmuxWorkerSummary[]>([]);
  const [windowPickerError, setWindowPickerError] = useState<string | null>(null);
  const [windowPickerLoading, setWindowPickerLoading] = useState(false);
  const terminalDirectInput = useTerminalPrefsStore((s) => s.terminalDirectInput);
  const setTerminalDirectInput = useTerminalPrefsStore((s) => s.setTerminalDirectInput);
  const inputLineRef = useRef<TerminalInputLineHandle>(null);
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
  const workerSubtitle = worker
    ? `${worker.nodeId} · ${worker.session}:${worker.windowName ?? worker.window ?? '0'}.${worker.pane ?? '0'}`
    : 'Missing worker target';
  // Connected, or within a short reconnect: the pane stays usable and keys queue.
  const heldConnected = useHeldConnection();
  const connectionReady = heldConnected && Boolean(client);
  const workerQuery = useMemo(
    () =>
      worker
        ? resourceQuery<TmuxWorkerListResult>(Methods.TMUX_WORKER_LIST, { machine: worker.nodeId })
        : undefined,
    [worker?.nodeId],
  );
  const inventory = useResourceQuery(focused ? workerQuery : undefined);
  // Keys need only the pane from the route; the gateway refuses input for a pane that is gone.
  // The inventory can be slow (its read times out under load and is not saved), so it never
  // holds keys back: it only stops them once it positively no longer lists this pane.
  const paneGone = worker ? inventoryLacksPane(inventory.data, worker) : false;
  const paneGoneMessage = worker
    ? `${worker.nodeId} no longer lists this pane (${worker.target}). Go back and choose it again.`
    : '';
  const workerReady = connectionReady && Boolean(worker) && !paneGone;
  const inventorySaved = savedForDisplay(inventory, heldConnected);
  // A read that keeps failing with nothing held is mentioned only past the shared grace.
  const inventoryFailing = usePersistentFlag(
    Boolean(inventory.error) && inventory.data === undefined,
  );
  const inventoryError =
    inventory.data !== undefined
      ? visibleReadError(inventory, inventorySaved)
      : inventoryFailing
        ? inventory.error
        : undefined;
  const requireWorkerInventory = useCallback(() => {
    if (
      !focused ||
      !worker ||
      !client ||
      client !== useConnectionStore.getState().client ||
      !heldConnectionCurrent()
    )
      throw new Error('Not connected to the gateway.');
    const current = workerQuery ? getResourceCache()?.read(workerQuery) : undefined;
    if (inventoryLacksPane(current?.data, worker))
      throw new Error(
        `${worker.nodeId} no longer lists this pane (${worker.target}). Go back and choose it again.`,
      );
    return current?.data;
  }, [client, workerQuery, worker, focused]);
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
  const onVoiceComposerLayout = useQuickActionComposerInset(showVoiceComposer);
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

  const appendTerminalTail = useCallback((chunk: string) => {
    terminalTailTextRef.current = appendTerminalTailText(
      terminalTailTextRef.current,
      chunk,
      TERMINAL_TAIL_MAX_CHARS,
    );
    setLines(
      terminalTailLinesFromText(terminalTailTextRef.current, TERMINAL_WORKER_SNAPSHOT_LINES),
    );
  }, []);

  // A request the dropped socket rejected belongs to the outage: quiet within the reconnect
  // grace, and the terminal's own status past it. Only a failure on a live socket shows here.
  const requestFailed = useCallback(
    (err: unknown) => {
      if (client?.connectionState === 'connected') setError(getErrorMessage(err));
    },
    [client],
  );

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
      requestFailed(err);
    }
  }, [client, requestFailed, status, worker]);

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
      .catch(requestFailed);
    return () => {
      mounted = false;
      unsub();
      client.request(Methods.TERMINAL_WORKER_UNSUBSCRIBE, { worker }, 5_000).catch((err: Error) => {
        // Unsubscribe can race with tmux pane teardown; after unmount there is no visible
        // worker terminal state to update, and socket cleanup releases handlers too.
        console.warn(`[terminal-worker] unsubscribe failed for ${worker.target}: ${err.message}`);
      });
    };
  }, [appendTerminalTail, client, requestFailed, status, worker]);

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

  const [heldInput, setHeldInput] = useState<HeldTerminalInput | null>(null);
  const workerInput = useWorkerTerminalInput(client, worker, {
    onRetry: (failure, attempt) =>
      setError((current) => keysRetryingNotice(failure, attempt) ?? current),
    onHold: setHeldInput,
  });
  const writeWorkerInput = workerInput.write;
  const sendInput = useCallback(
    (data: string) => {
      if (!client || !worker) return;
      try {
        requireWorkerInventory();
      } catch (error) {
        setError(getErrorMessage(error));
        return;
      }
      writeWorkerInput(data).then(
        () => setError(withoutKeysRetryingNotice),
        (err: unknown) => {
          if (!(err instanceof TerminalInputCancelledError)) setError(getErrorMessage(err));
        },
      );
    },
    [client, worker, requireWorkerInventory, writeWorkerInput],
  );

  // A key from the key bar or tmux shortcuts changes the pane's line, so the input line starts over.
  const sendKey = useCallback(
    (data: string) => {
      inputLineRef.current?.reset();
      sendInput(data);
    },
    [sendInput],
  );

  const openWindowPicker = useCallback(async () => {
    if (!client || !worker) return;
    setWindowPickerOpen(true);
    setWindowPickerLoading(true);
    setWindowPickerError(null);
    try {
      const result = requireWorkerInventory();
      if (!result) {
        setWindowPickerError('The window list is still loading. Try again in a moment.');
        setWindowPickerPanes([]);
        return;
      }
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
  }, [client, worker, requireWorkerInventory]);

  useEffect(() => {
    if (!windowPickerOpen || !worker) return;
    if (!workerReady || !inventory.data) {
      setWindowPickerPanes([]);
      setWindowPickerError(
        paneGone
          ? paneGoneMessage
          : !connectionReady
            ? 'Offline'
            : (inventoryError?.message ??
              'The window list is still loading. Try again in a moment.'),
      );
      return;
    }
    const panes =
      inventory.data.nodes
        .find((node) => node.nodeId === worker.nodeId)
        ?.workers.filter((pane) => pane.ref.session === worker.session) ?? [];
    setWindowPickerPanes(panes);
    setWindowPickerError(panes.length ? null : 'No windows found for this session.');
  }, [
    windowPickerOpen,
    worker,
    workerReady,
    inventory,
    inventoryError,
    paneGone,
    paneGoneMessage,
    connectionReady,
  ]);

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
    const data = workerVoiceInstructionInput(
      quickVoiceInstruction(voiceContext, voiceEditableInstruction),
    );
    if (!data || !client || !worker || isSending) return false;
    setIsSending(true);
    try {
      requireWorkerInventory();
      const sending = writeWorkerInput(data);
      // The instruction ends the pane's line with Enter, so the input line starts over as soon
      // as it is queued; keys typed while it is on its way belong to the next line.
      inputLineRef.current?.reset();
      await sending;
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setVoiceStatus('idle');
      setVoiceMessage('Instruction sent. Tap mic for the next worker nudge.');
      setVoiceContext('');
      setVoiceTranscript('');
      setVoiceDraft('');
      setVoiceWarning(null);
      setVoiceComposerOpen(false);
      return true;
    } catch (err) {
      if (!(err instanceof TerminalInputCancelledError))
        setVoiceWarning(`Send failed: ${getErrorMessage(err)}`);
      return false;
    } finally {
      setIsSending(false);
    }
  }, [
    client,
    isSending,
    voiceContext,
    voiceEditableInstruction,
    worker,
    requireWorkerInventory,
    writeWorkerInput,
  ]);

  const pendingSize = useRef<TerminalSize | null>(null);
  const resize = useCallback(
    (size: TerminalSize) => {
      if (!client || !worker) return;
      try {
        requireWorkerInventory();
      } catch {
        // Nobody pressed anything: send it again once the pane is usable, without an error.
        pendingSize.current = size;
        return;
      }
      pendingSize.current = null;
      client
        .request(
          Methods.TERMINAL_WORKER_RESIZE,
          { worker, cols: size.cols, rows: size.rows },
          10_000,
        )
        .catch(requestFailed);
    },
    [client, worker, requireWorkerInventory, requestFailed],
  );

  useEffect(() => {
    if (workerReady && pendingSize.current) resize(pendingSize.current);
  }, [workerReady, resize]);

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

  const quickVoiceKey = worker ? quickVoiceWorkerKey(worker) : '';
  useSharedViewSelection(
    useMemo(
      () => ({
        pathname: '/terminal/worker',
        params: {},
        workerSelection: worker ?? undefined,
      }),
      [worker],
    ),
  );
  useEffect(() => {
    setVoiceContext('');
  }, [quickVoiceKey]);
  const invokeQuickVoice = useCallback(
    (context?: string) => {
      if (context !== undefined) setVoiceContext(context);
      handleVoicePress();
    },
    [handleVoicePress],
  );
  useQuickActionVoiceTarget(
    quickVoiceKey,
    invokeQuickVoice,
    workerReady && !voiceRuntimePending && !voiceBusy,
    Boolean(worker),
  );

  const discardVoiceDraft = useCallback(() => {
    setVoiceStatus('idle');
    setVoiceMessage('Draft discarded. Tap mic to dictate again.');
    setVoiceContext('');
    setVoiceTranscript('');
    setVoiceDraft('');
    setVoiceWarning(null);
    setVoiceComposerOpen(false);
  }, []);

  return (
    <KeyboardAvoidingView
      testID="companion-screen-worker-terminal"
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
                {workerSubtitle}
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
                Keys
              </Text>
            </Pressable>
            <TerminalModeToggle mode={terminalViewMode} onChange={setTerminalViewMode} />
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
                {workerSubtitle}
              </Text>
            </View>
            <Pressable
              style={[styles.headerPill, showTmuxShortcuts && styles.tmuxToggleActive]}
              onPress={() => setShowTmuxShortcuts((current) => !current)}
            >
              <Text
                style={[styles.headerPillText, showTmuxShortcuts && styles.tmuxToggleTextActive]}
              >
                Keys
              </Text>
            </Pressable>
            <TerminalModeToggle mode={terminalViewMode} onChange={setTerminalViewMode} />
            <Pressable style={styles.headerButton} onPress={() => void loadSnapshot()}>
              <Ionicons name="refresh" size={18} color={colors.accent} />
            </Pressable>
            <Pressable style={styles.headerButton} onPress={() => setTerminalFullscreen(true)}>
              <Ionicons name="expand-outline" size={18} color={colors.accent} />
            </Pressable>
          </View>
        )}
        {/* Offline, the terminal's own status says so; a failed read would only repeat it. */}
        {paneGone || (heldConnected && (inventoryError || inventory.status === 'unsupported')) ? (
          <View>
            <Text style={styles.error}>
              {paneGone
                ? paneGoneMessage
                : (inventoryError?.message ?? 'Worker observations are unsupported.')}
            </Text>
            <Pressable
              disabled={!connectionReady}
              onPress={() => {
                if (workerQuery) void getResourceCache()?.retry(workerQuery);
              }}
            >
              <Text style={styles.headerButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.terminalArea}>
          <TerminalViewSurface
            ref={terminalRef}
            directInput={terminalDirectInput}
            initialText={lines.join('\r\n')}
            mode={terminalViewMode}
            onInput={sendInput}
            onResize={resize}
            rawHistoryText={terminalTailTextRef.current}
            readOnlyReason={!worker ? 'Missing worker target' : !heldConnected ? 'Offline' : null}
          />
        </View>
        {showVoiceComposer ? (
          <View
            style={styles.voicePanel}
            onLayout={(event) => {
              setVoicePanelWidth(event.nativeEvent.layout.width);
              onVoiceComposerLayout(event);
            }}
          >
            {voiceContext ? (
              <Text
                testID="worker-voice-context"
                style={{ color: colors.textSecondary, fontSize: 12 }}
              >
                {voiceContext}
              </Text>
            ) : null}
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
                    testID="worker-voice-instruction"
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
                        testID="worker-voice-send"
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
                      <Pressable
                        testID="worker-voice-discard"
                        style={styles.voiceCancelButton}
                        onPress={discardVoiceDraft}
                      >
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
              <Text testID="worker-voice-progress" style={styles.voiceProgressText}>
                {voiceMessage}
              </Text>
            ) : null}
            {voiceWarning ? <Text style={styles.voiceWarningText}>{voiceWarning}</Text> : null}
          </View>
        ) : null}
        {showTmuxShortcuts ? (
          <WorkerTmuxShortcutPanel
            disabled={!workerReady}
            onSend={sendKey}
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
          <TerminalHeldInput
            held={heldInput}
            onResend={workerInput.resend}
            onDiscard={() => {
              inputLineRef.current?.reset();
              workerInput.discard();
            }}
          />
          {terminalDirectInput ? null : (
            <TerminalInputLine ref={inputLineRef} disabled={!workerReady} onSend={sendInput} />
          )}
          <TerminalControlKeyBar
            label={null}
            runnerPane={worker}
            directInput={terminalDirectInput}
            onPress={(control) => sendKey(control.data)}
            onToggleDirectInput={() => setTerminalDirectInput(!terminalDirectInput)}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
