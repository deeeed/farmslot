import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type RecordingConfig, useAudioRecorder } from '@siteed/audio-studio';
import {
  ChatRecordWidget,
  SPEECH_AMPLITUDE_RANGE,
  waveformBarsFromAudioStudioDataPoints,
  type WaveformPoint,
} from '@siteed/audio-ui';
import { Asset } from 'expo-asset';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type CopilotFormatInstructionResult,
  Events,
  Methods,
  type Run,
  type RunForSlotResult,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
  type TerminalData,
  type TerminalSnapshotResult,
  type TmuxListResult,
  type TmuxWindow,
} from '@farmslot/protocol';

import voiceAsrTestClipAssetModule from '../../../assets/asr/voice-command-status.wav';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import { TerminalControlKeyBar } from '../../components/TerminalControlKeyBar';
import { TerminalOrientationButton } from '../../components/TerminalOrientationButton';
import {
  type TerminalSize,
  XtermTerminalView,
  type XtermTerminalViewHandle,
} from '../../components/XtermTerminalView';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import { ensureMicrophonePermission } from '../../lib/audio-permissions';
import { diffArtifactCandidate } from '../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import {
  type RunRefreshEvent,
  runRefreshEventMatches,
  runRefreshEventMatchesSlotWorkspace,
  runRefreshEventRunId,
} from '../../lib/run-refresh';
import {
  hasRunWorkspaceDiff,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isSlotWorkerProgressActive,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
} from '../../lib/task-progress';
import type { TerminalControlKey } from '../../lib/terminal-controls';
import { useTerminalOrientationControls } from '../../lib/terminal-orientation';
import { appendTerminalTailText, terminalTailLinesFromText } from '../../lib/terminal-tail';
import {
  buildCompanionTerminalTarget,
  type CompanionTerminalTargetParams,
  matchesCompanionTerminalTarget,
  shouldUseBareTerminalSessionForRun,
} from '../../lib/terminal-target';
import { baseStyles, colors, spacing } from '../../lib/theme';
import {
  downloadVoiceAsrModel,
  formatVoiceAsrSmokeTestResult,
  getConfiguredSherpaAsrModelId,
  getPreferredVoiceAsrModelId,
  getVoiceAsrModelState,
  getVoiceAsrSetupAction,
  getVoiceCopilotAvailability,
  getVoiceCopilotRuntimeState,
  resolveVoiceAsrModelPreference,
  smokeTestVoiceAsrModelFile,
  transcribeVoiceInstruction,
  VOICE_MODEL_STORAGE_KEY,
  type VoiceAsrModelState,
  type VoiceCopilotStatus,
} from '../../lib/voice-copilot';
import {
  buildPersistedVoiceDraft,
  parsePersistedVoiceDraft,
  voiceDraftStorageKey,
} from '../../lib/voice-draft-storage';
import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../lib/workspace-decisions';
import { summarizeRunWorkspaceNavMeta } from '../../lib/workspace-nav-meta';
import {
  targetWorkspaceRouteContextParams,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';
import { useTerminalPrefsStore } from '../../store/terminal-prefs';

import {
  type MobileTmuxActionMethod,
  TerminalFullscreenWorkspaceRail,
  TerminalSteeringContextCard,
  TerminalWorkspaceCockpit,
  TmuxControlPanel,
} from './components/slot-terminal-panels';
import { slotTerminalStyles as styles } from './styles/slot-terminal.styles';

const LINE_COUNT_OPTIONS = [25, 50, 100, 200] as const;
const TERMINAL_DATA_EVENT = 'terminal.data';
const TERMINAL_MODE_EVENT = 'terminal.mode';
const TERMINAL_EXITED_EVENT = 'terminal.exited';
const TERMINAL_TAIL_MAX_CHARS = 20_000;
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

interface VoiceRecordingStartOptions {
  clearExistingDraftOnStart?: boolean;
  failureStatus?: VoiceCopilotStatus;
}

function formatSnapshotTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetWarningForRun(run: Run, slotId: string): string | null {
  const warnings: string[] = [];
  if (run.slotId && run.slotId !== slotId) warnings.push(`run moved to ${run.slotId}`);
  if (!run.slotId) warnings.push('run has no active slot');
  return warnings.length ? `Target warning: ${warnings.join(', ')}` : null;
}

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function tmuxTargetParamsForMobile(target: CompanionTerminalTargetParams): {
  slotId: string;
  bareSession?: boolean;
} {
  return {
    slotId: target.slotId,
    ...(target.bareSession ? { bareSession: target.bareSession } : {}),
  };
}

function streamModeColor(mode: 'connecting' | 'live' | 'poll' | 'ended'): string {
  if (mode === 'live') return colors.statusOk;
  if (mode === 'poll' || mode === 'connecting') return colors.statusWarn;
  return colors.statusFail;
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
  const padCount = VOICE_LIVE_BARS_WINDOW - points.length;
  const pad: WaveformPoint[] = Array.from({ length: padCount }, (_, index) => ({
    id: -(index + 1),
    amplitude: 0,
    rms: 0,
    silent: true,
  }));
  return pad.concat(points);
}

function recipeRunIdForVisualPair(
  recipeRuns: RunRecipeRunsForRunResult['recipeRuns'],
  pair: VisualArtifactPair<ArtifactManifestEntry> | null,
): string {
  if (!pair) return recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
  const directRecipeRunId = pair.after.recipeRunId ?? pair.before.recipeRunId;
  if (directRecipeRunId) return directRecipeRunId;
  const sourceGroup = recipeRuns.find((group) => {
    const artifacts = artifactsForRecipeRun(group);
    return artifacts.some(
      (artifact) => artifact.path === pair.before.path || artifact.path === pair.after.path,
    );
  });
  return sourceGroup?.id ?? recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
}

export default function TerminalScreen() {
  const {
    slotId,
    runId,
    recipeRun,
    keys: keysParam,
    details: detailsParam,
    fullscreen: fullscreenParam,
    artifact: routeArtifactPath,
    workspace,
    decisionKind,
    voiceDraft: incomingVoiceDraftParam,
    voiceTranscript: incomingVoiceTranscriptParam,
  } = useLocalSearchParams<{
    slotId: string;
    runId?: string;
    recipeRun?: string;
    keys?: string | string[];
    details?: string | string[];
    fullscreen?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
    voiceDraft?: string | string[];
    voiceTranscript?: string | string[];
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const client = useConnectionStore((s) => s.client);
  const connectionStatus = useConnectionStore((s) => s.status);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const slot = useFleetStore((s) => s.fleet?.slots.find((entry) => entry.slot === slotId));
  const allowTerminalTouchKeyboard = useTerminalPrefsStore((s) => s.allowTerminalTouchKeyboard);
  const setAllowTerminalTouchKeyboard = useTerminalPrefsStore(
    (s) => s.setAllowTerminalTouchKeyboard,
  );
  const [lines, setLines] = useState<string[]>([]);
  const [lineCount, setLineCount] = useState<(typeof LINE_COUNT_OPTIONS)[number]>(50);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [snapshotRole, setSnapshotRole] = useState<string | null>(null);
  const [snapshotContextId, setSnapshotContextId] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [streamMode, setStreamMode] = useState<'connecting' | 'live' | 'poll' | 'ended'>(
    'connecting',
  );
  const [controlError, setControlError] = useState<string | null>(null);
  const [activeControlKey, setActiveControlKey] = useState<string | null>(null);
  const [tmuxWindows, setTmuxWindows] = useState<TmuxWindow[]>([]);
  const [tmuxError, setTmuxError] = useState<string | null>(null);
  const [activeTmuxAction, setActiveTmuxAction] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isSendingControl, setIsSendingControl] = useState(false);
  const [showTerminalControls, setShowTerminalControls] = useState(
    routeParamString(keysParam) === '1',
  );
  const [showTerminalOptions, setShowTerminalOptions] = useState(
    routeParamString(detailsParam) === '1',
  );
  const [terminalFullscreen, setTerminalFullscreen] = useState(
    routeParamString(fullscreenParam) === '1',
  );
  const orientationControls = useTerminalOrientationControls(terminalFullscreen);
  const [bareTerminalSession, setBareTerminalSession] = useState(false);
  const [targetRun, setTargetRun] = useState<Run | null>(null);
  const [targetWarning, setTargetWarning] = useState<string | null>(null);
  const [targetRecipeRuns, setTargetRecipeRuns] = useState<RunRecipeRunsForRunResult['recipeRuns']>(
    [],
  );
  const [targetRecipeArtifactCount, setTargetRecipeArtifactCount] = useState<number | null>(null);
  const [targetRecipeAvailabilityError, setTargetRecipeAvailabilityError] = useState<string | null>(
    null,
  );
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const terminalTargetParams = useMemo(
    () =>
      slotId
        ? buildCompanionTerminalTarget({
            slotId,
            runId,
            bareSession: bareTerminalSession,
          })
        : null,
    [bareTerminalSession, runId, slotId],
  );
  const terminalTargetParamsRef = useRef<CompanionTerminalTargetParams | null>(
    terminalTargetParams,
  );
  const terminalViewRef = useRef<XtermTerminalViewHandle>(null);
  const terminalSizeRef = useRef<TerminalSize>({ cols: 80, rows: 24 });
  const terminalTailTextRef = useRef('');
  const lineCountRef = useRef(lineCount);
  const consumedIncomingVoiceDraftRef = useRef('');
  const voiceDraftSlotRef = useRef<string | null>(null);
  const voiceDraftStateRef = useRef({ transcript: '', draft: '' });
  const targetRecipeRunsRequestRef = useRef(0);
  const voicePulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    lineCountRef.current = lineCount;
    setLines(terminalTailLinesFromText(terminalTailTextRef.current, lineCount));
  }, [lineCount]);

  useEffect(() => {
    terminalTargetParamsRef.current = terminalTargetParams;
  }, [terminalTargetParams]);

  const replaceTerminalTail = useCallback((rawText: string, timestamp: number | null) => {
    terminalTailTextRef.current = rawText.slice(-TERMINAL_TAIL_MAX_CHARS);
    setLines(terminalTailLinesFromText(terminalTailTextRef.current, lineCountRef.current));
    setLastUpdated(timestamp);
  }, []);

  const appendTerminalTail = useCallback((chunk: string, timestamp: number | null) => {
    terminalTailTextRef.current = appendTerminalTailText(
      terminalTailTextRef.current,
      chunk,
      TERMINAL_TAIL_MAX_CHARS,
    );
    setLines(terminalTailLinesFromText(terminalTailTextRef.current, lineCountRef.current));
    setLastUpdated(timestamp);
  }, []);
  const targetArtifacts = useMemo(
    () => (targetRun ? extractRunArtifactManifest(targetRun) : []),
    [targetRun],
  );
  const targetVisualPairSummary = useMemo(
    () =>
      groupVisualArtifactPairs(targetArtifacts, (artifact) =>
        artifactUrlForEntry(gatewayUrl, targetRun?.id ?? runId ?? '', artifact),
      ),
    [gatewayUrl, runId, targetArtifacts, targetRun?.id],
  );
  const targetRecipeVisualPairs = useMemo(() => {
    if (!targetRun?.id || targetVisualPairSummary.pairs.length > 0) return [];
    return groupVisualArtifactPairs(
      selectSlotRecipeArtifactsForPreviewScope(targetRecipeRuns, null),
      (artifact) => artifactUrlForEntry(gatewayUrl, targetRun.id, artifact),
    ).pairs;
  }, [gatewayUrl, targetRecipeRuns, targetRun?.id, targetVisualPairSummary.pairs.length]);
  const targetPriorityVisualPairs =
    targetVisualPairSummary.pairs.length > 0
      ? targetVisualPairSummary.pairs
      : targetRecipeVisualPairs;
  const targetPriorityVisualPair = targetPriorityVisualPairs[0] ?? null;
  const targetCompareRecipeRunId =
    targetVisualPairSummary.pairs.length > 0
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : recipeRunIdForVisualPair(targetRecipeRuns, targetPriorityVisualPair);
  const targetDiffArtifactPath = diffArtifactCandidate(targetArtifacts)?.path ?? null;
  const requestedArtifactPath = routeParamString(routeArtifactPath).trim();
  const targetArtifactCount = targetArtifacts.length;
  const targetRecipeAvailable =
    targetRecipeArtifactCount === null ? undefined : targetRecipeArtifactCount > 0;
  const targetDiffAvailable = targetRun
    ? Boolean(targetDiffArtifactPath) || hasRunWorkspaceDiff(targetRun)
    : undefined;
  const workspaceRecipeRunId = routeParamString(recipeRun);
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'terminal',
      ),
    [decisionKind, workspace],
  );
  const liveBadgeColor = streamModeColor(streamMode);
  const streamLabel =
    streamMode === 'connecting' ? 'Connecting' : streamMode === 'ended' ? 'Ended' : 'Live';
  const terminalInputDisabledReason = streamMode === 'ended' ? 'Read-only · terminal ended' : null;

  const loadInitialSnapshot = useCallback(async () => {
    const target = terminalTargetParamsRef.current;
    if (!client || !target) {
      setSnapshotError('Not connected to gateway.');
      return;
    }

    try {
      const result = await client.request<TerminalSnapshotResult>('terminal.snapshot', {
        ...target,
        lines: lineCountRef.current,
      });
      const snapshotText = result.lines.join('\n');
      replaceTerminalTail(snapshotText, result.timestamp);
      terminalViewRef.current?.reset(snapshotText.replace(/\n/g, '\r\n'));
      setSnapshotRole(result.role ?? null);
      setSnapshotContextId(result.contextId ?? null);
      setSnapshotError(null);
    } catch (error) {
      setSnapshotError(`Snapshot failed: ${getErrorMessage(error)}`);
    }
  }, [client, replaceTerminalTail]);

  const applyTargetRunState = useCallback(
    (run: Run | null): string | null => {
      setTargetRun(run);
      if (!run) {
        setTargetWarning(null);
        return null;
      }
      const warning = targetWarningForRun(run, slotId);
      setTargetWarning(warning);
      return warning;
    },
    [slotId],
  );

  const refreshTargetRun = useCallback(async (): Promise<{
    warning: string | null;
    run: Run | null;
  }> => {
    if (!client || !slotId) {
      applyTargetRunState(null);
      return { warning: null, run: null };
    }
    try {
      const result = runId
        ? await client.request<RunGetResult>('run.get', { runId })
        : await client.request<RunForSlotResult>('run.forSlot', { slotId });
      const run = result.run;
      if (!run) {
        applyTargetRunState(null);
        return { warning: null, run: null };
      }
      const warning = applyTargetRunState(run);
      return { warning, run };
    } catch (error) {
      const warning = `Could not verify run target: ${getErrorMessage(error)}`;
      setTargetWarning(warning);
      return { warning, run: null };
    }
  }, [applyTargetRunState, client, runId, slotId]);

  const refreshTargetRecipeRuns = useCallback(
    async (reason: string, targetRunId: string | null, reset: boolean) => {
      const requestId = targetRecipeRunsRequestRef.current + 1;
      targetRecipeRunsRequestRef.current = requestId;
      if (!client || !targetRunId) {
        setTargetRecipeRuns([]);
        setTargetRecipeArtifactCount(null);
        setTargetRecipeAvailabilityError(null);
        return;
      }
      if (reset) {
        setTargetRecipeRuns([]);
        setTargetRecipeArtifactCount(null);
        setTargetRecipeAvailabilityError(null);
      }
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId: targetRunId,
        });
        if (targetRecipeRunsRequestRef.current !== requestId) return;
        setTargetRecipeRuns(result.recipeRuns);
        const recipeArtifactCount = result.recipeRuns.reduce(
          (count, group) => count + artifactsForRecipeRun(group).length,
          0,
        );
        setTargetRecipeArtifactCount(recipeArtifactCount);
        setTargetRecipeAvailabilityError(null);
      } catch (error) {
        if (targetRecipeRunsRequestRef.current !== requestId) return;
        setTargetRecipeRuns([]);
        setTargetRecipeArtifactCount(null);
        setTargetRecipeAvailabilityError(
          `Recipe artifacts unavailable after ${reason}: ${getErrorMessage(error)}`,
        );
      }
    },
    [client],
  );

  useEffect(() => {
    if (!targetRun?.id) {
      targetRecipeRunsRequestRef.current += 1;
      setTargetRecipeRuns([]);
      setTargetRecipeArtifactCount(null);
      setTargetRecipeAvailabilityError(null);
      return;
    }

    void refreshTargetRecipeRuns('initial load', targetRun.id, true);
  }, [refreshTargetRecipeRuns, targetRun?.id]);

  useEffect(() => {
    if (!client || !slotId) return;
    const handleRunEvent = (payload: unknown, reason: string) => {
      const event = payload as RunRefreshEvent & { run?: Run | null };
      const workspaceRunId = targetRun?.id ?? runId ?? null;
      const matches = runId
        ? runRefreshEventMatches(runId, event)
        : runRefreshEventMatchesSlotWorkspace({ slotId, workspaceRunId }, event);
      if (!matches) return;

      const eventRunId = runRefreshEventRunId(event);
      if (event.run && (!runId || event.run.id === runId)) {
        applyTargetRunState(event.run);
        void refreshTargetRecipeRuns(reason, event.run.id, false);
        return;
      }

      void refreshTargetRun().then(({ run }) => {
        if (run?.id) {
          void refreshTargetRecipeRuns(reason, run.id, false);
        } else if (eventRunId === workspaceRunId) {
          void refreshTargetRecipeRuns(reason, eventRunId, false);
        }
      });
    };
    const unsubscribers = [
      client.subscribe(Events.RUN_CREATED, (payload) => handleRunEvent(payload, 'run.created')),
      client.subscribe(Events.RUN_UPDATED, (payload) => handleRunEvent(payload, 'run.updated')),
      client.subscribe(Events.RUN_COMPLETED, (payload) => handleRunEvent(payload, 'run.completed')),
      client.subscribe(Events.RUN_STEP_COMPLETED, (payload) =>
        handleRunEvent(payload, 'run.step.completed'),
      ),
      client.subscribe(Events.RUN_DECISION_NEW, (payload) =>
        handleRunEvent(payload, 'run.decision.new'),
      ),
      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) =>
        handleRunEvent(payload, 'run.decision.resolved'),
      ),
      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) =>
        handleRunEvent(payload, 'run.decision.updated'),
      ),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    applyTargetRunState,
    client,
    refreshTargetRecipeRuns,
    refreshTargetRun,
    runId,
    slotId,
    targetRun?.id,
  ]);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !targetRun?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: targetRun.slotId,
        runId: targetRun.id,
      })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((error: Error) => {
        setTaskProgressError(`Task progress unavailable: ${error.message}`);
      });
  }, [client, targetRun?.id, targetRun?.slotId]);

  useEffect(() => {
    if (!client || !targetRun) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(targetRun, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, targetRun]);

  useEffect(() => {
    if (!isWorkerProgressActive(targetRun)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, targetRun]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      const target = terminalTargetParamsRef.current;
      if (terminalInputDisabledReason || !client || !target || connectionStatus !== 'connected') {
        return;
      }
      client.request('terminal.input', { ...target, data }, 10_000).catch((error: Error) => {
        setSnapshotError(`Terminal input failed: ${error.message}`);
      });
    },
    [client, connectionStatus, terminalInputDisabledReason],
  );

  const handleTerminalResize = useCallback(
    (size: TerminalSize) => {
      terminalSizeRef.current = size;
      const target = terminalTargetParamsRef.current;
      if (!client || !target || connectionStatus !== 'connected') return;
      client.request('terminal.resize', { ...target, ...size }, 10_000).catch((error: Error) => {
        setSnapshotError(`Terminal resize failed: ${error.message}`);
      });
    },
    [client, connectionStatus],
  );

  useEffect(() => {
    if (!client || !slotId) return;
    if (connectionStatus !== 'connected') {
      setStreamMode('connecting');
      setSnapshotError('Waiting for gateway connection.');
      terminalViewRef.current?.setStatus('Waiting for gateway connection.');
      return;
    }
    let disposed = false;
    let target =
      terminalTargetParamsRef.current ??
      buildCompanionTerminalTarget({ slotId, runId, bareSession: false });
    setStreamMode('connecting');
    setSnapshotError(null);
    terminalViewRef.current?.setStatus('Connecting terminal…');

    const matchesTarget = (payload: { slotId?: string; runId?: string }) => {
      return matchesCompanionTerminalTarget(payload, target);
    };

    const unsubData = client.subscribe(TERMINAL_DATA_EVENT, (payload) => {
      const data = payload as TerminalData;
      if (!matchesTarget(data)) return;
      terminalViewRef.current?.write(data.data);
      appendTerminalTail(data.data, data.timestamp);
      setStreamMode('live');
      setSnapshotError(null);
      terminalViewRef.current?.setStatus('');
    });
    const unsubMode = client.subscribe(TERMINAL_MODE_EVENT, (payload) => {
      const data = payload as { slotId?: string; runId?: string; mode?: string };
      if (!matchesTarget(data)) return;
      setStreamMode(data.mode === 'poll' ? 'poll' : 'live');
    });
    const unsubExit = client.subscribe(TERMINAL_EXITED_EVENT, (payload) => {
      const data = payload as { slotId?: string; runId?: string };
      if (!matchesTarget(data)) return;
      setStreamMode('ended');
    });

    const startTerminalSubscription = async () => {
      const targetResult = await refreshTargetRun();
      if (disposed) return;
      const nextBareSession = shouldUseBareTerminalSessionForRun({
        requestedRunId: runId,
        requestedSlotId: slotId,
        run: targetResult.run,
      });
      target = buildCompanionTerminalTarget({
        slotId,
        runId,
        bareSession: nextBareSession,
      });
      terminalTargetParamsRef.current = target;
      setBareTerminalSession(nextBareSession);

      try {
        await client.request('terminal.subscribe', {
          ...target,
          interactive: true,
          cols: terminalSizeRef.current.cols,
          rows: terminalSizeRef.current.rows,
        });
        if (!disposed) {
          setSnapshotError(null);
          terminalViewRef.current?.setStatus('');
        }
      } catch (error) {
        if (!disposed) {
          setSnapshotError(`Live terminal subscribe failed: ${getErrorMessage(error)}`);
          setStreamMode('ended');
          terminalViewRef.current?.setStatus(
            `Terminal subscribe failed: ${getErrorMessage(error)}`,
          );
        }
      }
    };

    void startTerminalSubscription();

    return () => {
      disposed = true;
      unsubData();
      unsubMode();
      unsubExit();
      if (client.connectionState !== 'connected') return;
      client.request('terminal.unsubscribe', target).catch((error: Error) => {
        // Unsubscribe can race with slot teardown; after unmount there is no visible terminal
        // state to update, and the gateway also releases handlers when the socket closes.
        console.warn(`[terminal] unsubscribe failed for ${slotId}: ${error.message}`);
      });
    };
  }, [appendTerminalTail, client, connectionStatus, refreshTargetRun, runId, slotId]);

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    loadInitialSnapshot();
  }, [connectionStatus, lineCount, loadInitialSnapshot]);

  const resolveTerminalTargetRun = useCallback(async (): Promise<Run | null> => {
    if (!client || !slotId) return null;
    return (await refreshTargetRun()).run;
  }, [client, refreshTargetRun, runId, slotId]);

  const sendControlKey = useCallback(
    async (control: TerminalControlKey) => {
      const target = terminalTargetParamsRef.current;
      if (!client || !target || isSendingControl) return;
      setIsSendingControl(true);
      setActiveControlKey(control.label);
      setControlError(null);
      try {
        await client.request('terminal.input', {
          ...target,
          data: control.data,
        });
        await Haptics.impactAsync(
          control.danger ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
        );
      } catch (error) {
        setControlError(`Control failed: ${getErrorMessage(error)}`);
      } finally {
        setIsSendingControl(false);
        setActiveControlKey(null);
      }
    },
    [client, isSendingControl],
  );

  const refreshTmuxWindows = useCallback(async () => {
    const target = terminalTargetParamsRef.current;
    if (!client || !target || connectionStatus !== 'connected') {
      setTmuxWindows([]);
      return;
    }
    try {
      const result = await client.request<TmuxListResult>(
        Methods.TMUX_LIST,
        tmuxTargetParamsForMobile(target),
      );
      setTmuxWindows(result.windows);
      setTmuxError(null);
    } catch (error) {
      setTmuxWindows([]);
      setTmuxError(`Tmux state failed: ${getErrorMessage(error)}`);
    }
  }, [client, connectionStatus]);

  const runTmuxAction = useCallback(
    async (label: string, method: MobileTmuxActionMethod, params: Record<string, unknown> = {}) => {
      const target = terminalTargetParamsRef.current;
      if (!client || !target || connectionStatus !== 'connected' || activeTmuxAction) return;
      setActiveTmuxAction(label);
      setTmuxError(null);
      try {
        await client.request(method, {
          ...tmuxTargetParamsForMobile(target),
          ...params,
        });
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        await refreshTmuxWindows();
      } catch (error) {
        setTmuxError(`${label} failed: ${getErrorMessage(error)}`);
      } finally {
        setActiveTmuxAction(null);
      }
    },
    [activeTmuxAction, client, connectionStatus, refreshTmuxWindows],
  );

  useEffect(() => {
    if (connectionStatus !== 'connected' || (!showTerminalControls && !showTerminalOptions)) return;
    void refreshTmuxWindows();
  }, [
    connectionStatus,
    refreshTmuxWindows,
    showTerminalControls,
    showTerminalOptions,
    terminalTargetParams,
  ]);

  const sendTerminalText = useCallback(
    async (text: string, setError: (message: string | null) => void): Promise<boolean> => {
      const trimmedText = text.trim();
      if (!client || !slotId || !trimmedText || isSending) return false;

      setIsSending(true);
      try {
        const target = terminalTargetParamsRef.current;
        if (target) {
          await client.request('terminal.input', {
            ...target,
            data: `${trimmedText}\r`,
          });
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setError(null);
          return true;
        }
        const run = await resolveTerminalTargetRun();
        if (!run) {
          setError('Could not verify an active run for this slot. Terminal send blocked.');
          return false;
        }
        if (run.slotId && run.slotId !== slotId) {
          setError(`Run moved to ${run.slotId}. Open that slot terminal before sending.`);
          return false;
        }
        if (!run.slotId) {
          setError('Run no longer has an active slot. Terminal send blocked.');
          return false;
        }
        await client.request('terminal.send', {
          slotId,
          runId: run.id,
          text: trimmedText,
          enter: true,
        });
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setError(null);
        return true;
      } catch (error) {
        setError(`Send failed: ${getErrorMessage(error)}`);
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [client, isSending, resolveTerminalTargetRun, slotId],
  );

  const voiceRecorder = useAudioRecorder();
  const [voiceStatus, setVoiceStatus] = useState<VoiceCopilotStatus>('idle');
  const [voiceMessage, setVoiceMessage] = useState(getVoiceCopilotAvailability().message);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceDraft, setVoiceDraft] = useState('');
  const [voiceWarning, setVoiceWarning] = useState<string | null>(null);
  const [voiceTargetSuggestion, setVoiceTargetSuggestion] = useState<
    CopilotFormatInstructionResult['targetSuggestion'] | null
  >(null);
  const [selectedVoiceModelId, setSelectedVoiceModelId] = useState(getPreferredVoiceAsrModelId);
  const [voiceModelState, setVoiceModelState] = useState<VoiceAsrModelState | null>(null);
  const [voiceRuntimeReady, setVoiceRuntimeReady] = useState<boolean | null>(null);
  const [isPreparingVoiceRecorder, setIsPreparingVoiceRecorder] = useState(false);
  const [isFormattingVoice, setIsFormattingVoice] = useState(false);
  const [isDownloadingVoiceModel, setIsDownloadingVoiceModel] = useState(false);
  const [voiceComposerOpen, setVoiceComposerOpen] = useState(false);
  const [voiceDraftHydratedSlotId, setVoiceDraftHydratedSlotId] = useState<string | null>(null);
  const [pendingAutoFormat, setPendingAutoFormat] = useState<{
    transcript: string;
  } | null>(null);
  const hasVoiceDraft = voiceDraft.trim().length > 0;
  const voiceEditableInstruction = hasVoiceDraft ? voiceDraft : voiceTranscript;
  const hasVoiceEditableInstruction = voiceEditableInstruction.trim().length > 0;
  const voiceTargetMismatchSlotId =
    voiceTargetSuggestion?.slotId && voiceTargetSuggestion.slotId !== slotId
      ? voiceTargetSuggestion.slotId
      : null;
  const voiceGatewayReady = connectionStatus === 'connected' && Boolean(client);
  const voiceTranscriptNeedsCleanup = voiceStatus === 'transcript_ready' && !hasVoiceDraft;
  const canCleanVoiceTranscript =
    voiceGatewayReady &&
    voiceTranscriptNeedsCleanup &&
    hasVoiceEditableInstruction &&
    !isSending &&
    !isFormattingVoice;
  const canSendVoiceDraft =
    voiceGatewayReady &&
    hasVoiceEditableInstruction &&
    !voiceTranscriptNeedsCleanup &&
    !voiceTargetMismatchSlotId &&
    !isSending &&
    !isFormattingVoice &&
    voiceStatus !== 'transcribing';
  const canRunVoicePrimaryAction =
    canSendVoiceDraft || canCleanVoiceTranscript || Boolean(voiceTargetMismatchSlotId);
  const [voicePanelWidth, setVoicePanelWidth] = useState(0);
  const voiceRecorderBusy =
    isPreparingVoiceRecorder ||
    voiceStatus === 'transcribing' ||
    isFormattingVoice ||
    isDownloadingVoiceModel;
  const voiceRuntimePending = voiceRuntimeReady == null;
  const voiceRuntimeUnavailable = voiceRuntimeReady === false;
  const voiceModelNeedsSetup = Boolean(voiceModelState && voiceModelState.status !== 'ready');
  const voiceSetupAction = getVoiceAsrSetupAction({
    runtimeReady: voiceRuntimeReady,
    modelStatus: voiceModelState?.status,
    modelSource: voiceModelState?.source,
    isDownloading: isDownloadingVoiceModel,
    hasEditableInstruction: hasVoiceEditableInstruction,
    isRecordingOrTranscribing: voiceStatus === 'recording' || voiceStatus === 'transcribing',
    isFormatting: isFormattingVoice,
  });
  const canDownloadVoiceModel = voiceSetupAction.mode === 'download' && voiceSetupAction.enabled;
  const voiceAsrBlocked = voiceRuntimeReady !== true || voiceModelNeedsSetup;
  const canCloseEmptyVoiceComposer =
    voiceComposerOpen &&
    !hasVoiceEditableInstruction &&
    voiceStatus !== 'recording' &&
    voiceStatus !== 'transcribing' &&
    !voiceRecorderBusy;
  const showInputBar = showTerminalControls || Boolean(controlError);
  const showVoiceComposer =
    voiceComposerOpen ||
    voiceStatus !== 'idle' ||
    hasVoiceEditableInstruction ||
    isPreparingVoiceRecorder ||
    isFormattingVoice;
  const showVoiceProgressText =
    Boolean(voiceMessage) &&
    (isPreparingVoiceRecorder ||
      voiceStatus === 'transcribing' ||
      isFormattingVoice ||
      isDownloadingVoiceModel);
  const animateVoiceButton =
    voiceStatus === 'recording' ||
    voiceStatus === 'transcribing' ||
    isPreparingVoiceRecorder ||
    isFormattingVoice;
  const voiceButtonPulseStyle = {
    opacity: voicePulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.48] }),
    transform: [
      {
        scale: voicePulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }),
      },
    ],
  };
  const floatingVoiceBottom = spacing.lg + insets.bottom;
  const voiceWidgetWidth = Math.max(1, voicePanelWidth - spacing.md * 2);

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

  useEffect(() => {
    voiceDraftStateRef.current = { transcript: voiceTranscript, draft: voiceDraft };
  }, [voiceDraft, voiceTranscript]);

  useEffect(() => {
    const incomingDraft = routeParamString(incomingVoiceDraftParam).trim();
    const incomingTranscript = routeParamString(incomingVoiceTranscriptParam).trim();
    if (!incomingDraft && !incomingTranscript) return;

    const incomingKey = `${slotId}\0${incomingDraft}\0${incomingTranscript}`;
    if (consumedIncomingVoiceDraftRef.current === incomingKey) return;
    consumedIncomingVoiceDraftRef.current = incomingKey;

    setVoiceStatus(incomingDraft || incomingTranscript ? 'transcript_ready' : 'idle');
    setVoiceMessage(
      incomingDraft
        ? 'Draft moved to this target. Review, edit, then tap Send.'
        : 'Transcript moved to this target. Cleaning it before sending.',
    );
    setVoiceTranscript(incomingTranscript);
    setVoiceDraft(incomingDraft);
    setVoiceComposerOpen(true);
    setVoiceWarning(null);
    setVoiceTargetSuggestion(null);
    setPendingAutoFormat(
      !incomingDraft && incomingTranscript ? { transcript: incomingTranscript } : null,
    );
    voiceDraftSlotRef.current = slotId;
    setVoiceDraftHydratedSlotId(slotId);
  }, [incomingVoiceDraftParam, incomingVoiceTranscriptParam, slotId]);

  useEffect(() => {
    if (!slotId) return;
    const incomingDraft = routeParamString(incomingVoiceDraftParam).trim();
    const incomingTranscript = routeParamString(incomingVoiceTranscriptParam).trim();
    if (incomingDraft || incomingTranscript) {
      voiceDraftSlotRef.current = slotId;
      setVoiceDraftHydratedSlotId(slotId);
      return;
    }

    let disposed = false;
    setVoiceDraftHydratedSlotId(null);
    if (voiceDraftSlotRef.current !== slotId) {
      voiceDraftSlotRef.current = slotId;
      voiceDraftStateRef.current = { transcript: '', draft: '' };
      setVoiceStatus('idle');
      setVoiceTranscript('');
      setVoiceDraft('');
      setVoiceComposerOpen(false);
      setVoiceTargetSuggestion(null);
      setPendingAutoFormat(null);
    }
    AsyncStorage.getItem(voiceDraftStorageKey(slotId))
      .then((raw) => {
        if (disposed) return;
        const persisted = parsePersistedVoiceDraft(raw, slotId);
        const current = voiceDraftStateRef.current;
        if (persisted && !current.transcript.trim() && !current.draft.trim()) {
          setVoiceStatus('transcript_ready');
          setVoiceMessage('Restored unsent voice draft. Review, edit, then tap Send.');
          setVoiceTranscript(persisted.transcript);
          setVoiceDraft(persisted.draft);
          setVoiceComposerOpen(true);
          setVoiceWarning(null);
          setVoiceTargetSuggestion(null);
          setPendingAutoFormat(null);
        }
        setVoiceDraftHydratedSlotId(slotId);
      })
      .catch((error: Error) => {
        if (!disposed) {
          setVoiceWarning(`Failed to restore voice draft: ${error.message}`);
          setVoiceDraftHydratedSlotId(slotId);
        }
      });
    return () => {
      disposed = true;
    };
  }, [incomingVoiceDraftParam, incomingVoiceTranscriptParam, slotId]);

  useEffect(() => {
    if (!slotId || voiceDraftHydratedSlotId !== slotId) return;
    if (voiceStatus === 'recording' || voiceStatus === 'transcribing') return;

    const persisted = buildPersistedVoiceDraft({
      slotId,
      transcript: voiceTranscript,
      draft: voiceDraft,
    });
    const key = voiceDraftStorageKey(slotId);
    const write = persisted
      ? AsyncStorage.setItem(key, JSON.stringify(persisted))
      : AsyncStorage.removeItem(key);
    write.catch((error: Error) => {
      setVoiceWarning(`Failed to persist voice draft: ${error.message}`);
    });
  }, [slotId, voiceDraft, voiceDraftHydratedSlotId, voiceStatus, voiceTranscript]);

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
  const showVoiceWaveformSurface = voiceStatus === 'recording';
  const voiceInputLocked = voiceStatus === 'transcribing' || isFormattingVoice;

  const refreshVoiceModelState = useCallback(async () => {
    try {
      const state = await getVoiceAsrModelState(selectedVoiceModelId);
      setVoiceModelState(state);
    } catch (error) {
      setVoiceWarning(`Failed to inspect voice ASR model: ${getErrorMessage(error)}`);
    }
  }, [selectedVoiceModelId]);

  useEffect(() => {
    void refreshVoiceModelState();
  }, [refreshVoiceModelState]);

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
          const nextModelId = preference.modelId;
          const state = await getVoiceAsrModelState(nextModelId);
          if (disposed) return;
          setSelectedVoiceModelId(nextModelId);
          setVoiceModelState(state);
        } catch (error) {
          if (!disposed) {
            setVoiceWarning(`Failed to refresh voice ASR configuration: ${getErrorMessage(error)}`);
          }
        }
      };
      void refreshFocusedVoiceConfiguration();
      return () => {
        disposed = true;
      };
    }, [selectedVoiceModelId]),
  );

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
      .catch((error: Error) => {
        if (disposed) return;
        setVoiceRuntimeReady(false);
        setVoiceWarning(`Sherpa native runtime check failed: ${error.message}`);
        setVoiceMessage('Sherpa native runtime check failed. Rebuild the development app.');
      });
    return () => {
      disposed = true;
    };
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

  const startVoiceRecording = useCallback(
    async (options: VoiceRecordingStartOptions = {}) => {
      if (isPreparingVoiceRecorder) return;
      setVoiceComposerOpen(true);
      if (voiceRuntimeReady !== true) {
        setVoiceStatus('error');
        setVoiceMessage(
          voiceRuntimePending
            ? 'Waiting for Sherpa native runtime check before recording.'
            : 'Sherpa native runtime is unavailable. Rebuild the development app.',
        );
        setVoiceWarning(
          voiceRuntimePending
            ? 'On-device ASR runtime check is still running.'
            : 'On-device ASR requires a native development build with Sherpa linked.',
        );
        return;
      }
      setVoiceWarning(null);
      setVoiceMessage('Recording voice instruction. Tap Stop when finished.');
      setIsPreparingVoiceRecorder(true);
      try {
        setVoiceMessage('Preparing microphone access…');
        const permissionGate = await ensureMicrophonePermission();
        if (!permissionGate.granted) {
          setVoiceStatus(options.failureStatus ?? 'error');
          setVoiceMessage(permissionGate.message);
          setVoiceWarning(permissionGate.message);
          if (permissionGate.blocked) promptOpenMicrophoneSettings(permissionGate.message);
          return;
        }
        await voiceRecorder.prepareRecording(VOICE_RECORDING_CONFIG);
        setVoiceMessage('Recording voice instruction. Tap Stop when finished.');
        await voiceRecorder.startRecording(VOICE_RECORDING_CONFIG);
        if (options.clearExistingDraftOnStart) {
          setVoiceTranscript('');
          setVoiceDraft('');
          setVoiceTargetSuggestion(null);
          setPendingAutoFormat(null);
        }
        setVoiceStatus('recording');
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        setVoiceStatus(options.failureStatus ?? 'error');
        setVoiceMessage(
          options.failureStatus
            ? `Recording failed: ${errorMessage}. Previous draft was kept.`
            : `Recording failed: ${errorMessage}`,
        );
        setVoiceWarning(`Check microphone permission. ${errorMessage}`);
      } finally {
        setIsPreparingVoiceRecorder(false);
      }
    },
    [
      isPreparingVoiceRecorder,
      promptOpenMicrophoneSettings,
      voiceRecorder,
      voiceRuntimePending,
      voiceRuntimeReady,
    ],
  );

  const stopVoiceRecording = useCallback(async () => {
    setVoiceStatus('transcribing');
    setVoiceWarning(null);
    try {
      const recording = await voiceRecorder.stopRecording();
      const result = await transcribeVoiceInstruction(recording, selectedVoiceModelId);
      setVoiceStatus(result.status);
      setVoiceMessage(result.message);
      setVoiceTranscript(result.transcript);
      if (result.status === 'transcript_ready') {
        setPendingAutoFormat({ transcript: result.transcript });
      } else {
        setPendingAutoFormat(null);
      }
      if (result.status === 'model_unavailable') {
        setVoiceWarning(
          'Type or paste the transcript manually until an on-device ASR model is configured.',
        );
      }
    } catch (error) {
      setVoiceStatus('error');
      setVoiceMessage(`Transcription failed: ${getErrorMessage(error)}`);
    }
  }, [selectedVoiceModelId, voiceRecorder]);

  const resetVoiceCopilotAfterSend = useCallback((message: string) => {
    setVoiceStatus('idle');
    setVoiceMessage(message);
    setVoiceTranscript('');
    setVoiceDraft('');
    setVoiceWarning(null);
    setVoiceTargetSuggestion(null);
    setPendingAutoFormat(null);
    setVoiceComposerOpen(false);
  }, []);

  const formatVoiceDraftFromTranscript = useCallback(
    async (rawTranscript: string, automatic = false): Promise<boolean> => {
      const transcript = rawTranscript.trim();
      if (!transcript || isFormattingVoice) return false;
      if (!client || connectionStatus !== 'connected') {
        setVoiceWarning('Connect to the gateway before cleaning a voice instruction.');
        setVoiceMessage('Gateway connection required before cleaning.');
        return false;
      }
      if (!slotId) {
        setVoiceWarning('Open a slot terminal before cleaning a voice instruction.');
        return false;
      }
      setIsFormattingVoice(true);
      setVoiceWarning(null);
      setVoiceTargetSuggestion(null);
      if (automatic) {
        setVoiceMessage('Cleaning transcript through gateway intelligence. Review before sending.');
      }
      try {
        let formatRunId = targetRun?.id ?? runId;
        if (!formatRunId) {
          const resolvedRun = await resolveTerminalTargetRun();
          formatRunId = resolvedRun?.id;
        }
        const result = await client.request<CopilotFormatInstructionResult>(
          'copilot.formatInstruction',
          {
            transcript,
            slotId,
            runId: formatRunId,
            terminalTail: lines.slice(-20),
          },
          30_000,
        );
        const formattedDraft = result.draftText?.trim();
        if (!formattedDraft) {
          setVoiceWarning('copilot.formatInstruction returned no draft text.');
          return false;
        }
        const warnings = result.warnings?.filter(Boolean) ?? [];
        const suggestedTarget = result.targetSuggestion ?? null;
        const suggestedMismatchSlotId =
          suggestedTarget?.slotId && suggestedTarget.slotId !== slotId
            ? suggestedTarget.slotId
            : null;
        setVoiceDraft(formattedDraft);
        setVoiceTargetSuggestion(suggestedTarget);
        setVoiceWarning(warnings.length ? warnings.join(' ') : null);
        if (automatic) {
          setVoiceMessage(
            suggestedMismatchSlotId
              ? `Draft cleaned for ${suggestedMismatchSlotId}. Open that target before sending.`
              : 'Draft ready. Review, edit, then tap Send.',
          );
        }
        return true;
      } catch (error) {
        const prefix = automatic ? 'Auto-clean failed' : 'Clean up failed';
        setVoiceWarning(`${prefix} via copilot.formatInstruction: ${getErrorMessage(error)}`);
        return false;
      } finally {
        setIsFormattingVoice(false);
      }
    },
    [
      client,
      connectionStatus,
      isFormattingVoice,
      lines,
      resolveTerminalTargetRun,
      runId,
      slotId,
      targetRun,
    ],
  );

  useEffect(() => {
    if (!pendingAutoFormat) return;
    let disposed = false;
    formatVoiceDraftFromTranscript(pendingAutoFormat.transcript, true)
      .then(() => {
        if (!disposed) setPendingAutoFormat(null);
      })
      .catch((error: Error) => {
        if (!disposed) {
          setVoiceWarning(`Auto-clean failed: ${error.message}`);
          setPendingAutoFormat(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [formatVoiceDraftFromTranscript, pendingAutoFormat]);

  const sendVoiceDraft = useCallback(async () => {
    if (isFormattingVoice || voiceStatus === 'transcribing') {
      setVoiceWarning('Wait for transcript cleanup to finish before sending.');
      setVoiceMessage('Review the cleaned draft before sending.');
      return;
    }
    if (voiceTranscriptNeedsCleanup) {
      const cleaned = await formatVoiceDraftFromTranscript(voiceEditableInstruction, false);
      if (cleaned) {
        setVoiceMessage('Draft ready. Review, edit, then tap Send.');
      }
      return;
    }
    if (!voiceGatewayReady) {
      setVoiceWarning('Connect to the gateway before sending a voice draft.');
      setVoiceMessage('Gateway connection required before sending.');
      return;
    }
    if (voiceTargetMismatchSlotId) {
      setVoiceWarning(
        `This draft targets ${voiceTargetMismatchSlotId}. Open that slot before sending so it cannot be sent to ${slotId}.`,
      );
      setVoiceMessage('Open the suggested target before sending this voice draft.');
      return;
    }
    const sent = await sendTerminalText(voiceEditableInstruction, setVoiceWarning);
    if (sent) {
      resetVoiceCopilotAfterSend(
        'Instruction sent. Tap mic to dictate the next worker instruction.',
      );
    }
  }, [
    resetVoiceCopilotAfterSend,
    sendTerminalText,
    slotId,
    voiceEditableInstruction,
    voiceGatewayReady,
    formatVoiceDraftFromTranscript,
    isFormattingVoice,
    voiceStatus,
    voiceTargetMismatchSlotId,
    voiceTranscriptNeedsCleanup,
  ]);

  const openVoiceTargetSuggestion = useCallback(() => {
    if (!voiceTargetMismatchSlotId) return;
    const draft = voiceDraft.trim();
    const transcript = voiceTranscript.trim();
    router.push({
      pathname: '/terminal/[slotId]',
      params: {
        slotId: voiceTargetMismatchSlotId,
        ...targetWorkspaceRouteContextParams('terminal', workspaceRouteContext.decisionKind),
        ...(draft ? { voiceDraft: draft } : {}),
        ...(transcript ? { voiceTranscript: transcript } : {}),
      },
    });
  }, [router, voiceDraft, voiceTargetMismatchSlotId, voiceTranscript, workspaceRouteContext]);

  const discardVoiceDraft = useCallback(() => {
    setVoiceStatus('idle');
    setVoiceMessage('Draft discarded. Tap mic to dictate again.');
    setVoiceTranscript('');
    setVoiceDraft('');
    setVoiceWarning(null);
    setVoiceTargetSuggestion(null);
    setPendingAutoFormat(null);
    setVoiceComposerOpen(false);
  }, []);

  const closeEmptyVoiceComposer = useCallback(() => {
    setVoiceStatus('idle');
    setVoiceMessage('Tap mic to dictate a worker instruction.');
    setVoiceWarning(null);
    setVoiceTargetSuggestion(null);
    setPendingAutoFormat(null);
    setVoiceComposerOpen(false);
  }, []);

  const retakeVoiceInstruction = useCallback(() => {
    setVoiceComposerOpen(true);
    if (voiceAsrBlocked) {
      setVoiceWarning(
        voiceModelNeedsSetup
          ? 'Download a transcription model before replacing this draft by voice.'
          : 'Voice runtime is not ready; keep editing the draft manually.',
      );
      return;
    }
    setVoiceWarning(null);
    void startVoiceRecording({
      clearExistingDraftOnStart: true,
      failureStatus: voiceStatus,
    });
  }, [startVoiceRecording, voiceAsrBlocked, voiceModelNeedsSetup, voiceStatus]);

  const openVoiceComposer = useCallback(() => {
    setVoiceComposerOpen(true);
    if (hasVoiceEditableInstruction || voiceRecorderBusy) return;
    if (voiceAsrBlocked) {
      setVoiceStatus('idle');
      setVoiceWarning(
        voiceModelNeedsSetup
          ? 'Download a transcription model in Settings, or type the instruction here.'
          : 'Voice runtime is not ready; type the instruction here.',
      );
      return;
    }
    void startVoiceRecording();
  }, [
    hasVoiceEditableInstruction,
    startVoiceRecording,
    voiceAsrBlocked,
    voiceModelNeedsSetup,
    voiceRecorderBusy,
  ]);

  const handleFloatingVoicePress = useCallback(() => {
    if (voiceStatus === 'recording') {
      void stopVoiceRecording();
      return;
    }
    if (voiceRecorderBusy) return;
    if (hasVoiceEditableInstruction) {
      retakeVoiceInstruction();
      return;
    }
    openVoiceComposer();
  }, [
    hasVoiceEditableInstruction,
    openVoiceComposer,
    retakeVoiceInstruction,
    stopVoiceRecording,
    voiceRecorderBusy,
    voiceStatus,
  ]);

  const openVoiceSettings = useCallback(() => {
    router.push('/settings');
  }, [router]);

  const downloadSelectedVoiceModel = useCallback(async () => {
    if (!canDownloadVoiceModel) {
      openVoiceSettings();
      return;
    }
    setIsDownloadingVoiceModel(true);
    setVoiceWarning(null);
    setVoiceMessage(`Downloading ${voiceModelState?.model.name ?? selectedVoiceModelId}…`);
    try {
      const state = await downloadVoiceAsrModel(selectedVoiceModelId, (nextState) => {
        setVoiceModelState(nextState);
        setVoiceMessage(nextState.message);
      });
      setVoiceModelState(state);
      setVoiceMessage(`Testing ${state.model.name} with bundled voice clip…`);
      const [asset] = await Asset.loadAsync(voiceAsrTestClipAssetModule);
      const fileUri = asset.localUri ?? asset.uri;
      if (!fileUri) throw new Error('Bundled ASR test clip did not resolve to a file URI.');
      const testResult = await smokeTestVoiceAsrModelFile(fileUri, selectedVoiceModelId);
      setVoiceMessage(
        `Transcription model ready. Test ${formatVoiceAsrSmokeTestResult(testResult)}. Tap mic to record.`,
      );
      setVoiceWarning(null);
    } catch (error) {
      setVoiceWarning(`Model setup failed: ${getErrorMessage(error)}`);
      await refreshVoiceModelState();
    } finally {
      setIsDownloadingVoiceModel(false);
    }
  }, [
    canDownloadVoiceModel,
    openVoiceSettings,
    refreshVoiceModelState,
    selectedVoiceModelId,
    voiceModelState?.model.name,
  ]);

  const goBackOrHome = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/fleet');
  }, [router]);

  const toggleTerminalFullscreen = useCallback(() => {
    setTerminalFullscreen((current) => !current);
  }, []);

  const showFloatingVoiceButton =
    !terminalInputDisabledReason &&
    !showInputBar &&
    !showVoiceComposer &&
    !hasVoiceEditableInstruction &&
    !voiceRecorderBusy;
  const primaryDecision = selectPrimaryWorkspaceDecision(targetRun);
  const readyDecision = selectReadyWorkspaceDecision(targetRun);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(targetRun);
  const retroDecision = selectRetrospectiveWorkspaceDecision(targetRun);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(targetRun);
  const activeTaskProgress = isWorkerProgressActive(targetRun)
    ? (effectiveTaskProgressForRun(targetRun, taskProgress) ?? null)
    : null;
  const fallbackTaskProgress =
    !activeTaskProgress && (isWorkerProgressActive(targetRun) || isSlotWorkerProgressActive(slot))
      ? fallbackTaskProgressSummary(targetRun, slot)
      : null;
  const terminalHeaderMaxHeight = Math.max(
    180,
    Math.floor(windowHeight * (showTerminalOptions ? 0.46 : 0.32)),
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
      style={[
        baseStyles.container,
        terminalFullscreen && styles.fullscreenContainer,
        { paddingTop: insets.top },
      ]}
    >
      <StatusBar hidden={terminalFullscreen} style="light" />
      {!terminalFullscreen && <ConnectionBanner compact />}
      {terminalFullscreen ? (
        <>
          <View style={[styles.fullscreenOverlay, { top: insets.top + spacing.xs }]}>
            <Pressable style={styles.fullscreenBackButton} onPress={goBackOrHome}>
              <Text style={styles.fullscreenBackText}>‹</Text>
            </Pressable>
            <View style={styles.fullscreenIdentity}>
              <Text style={styles.fullscreenTitle} numberOfLines={1}>
                {slotId ?? 'unknown slot'}
              </Text>
              <Text style={styles.fullscreenMeta} numberOfLines={1}>
                {streamLabel} · {lines.length} lines
              </Text>
            </View>
            <Pressable
              style={[styles.fullscreenPill, showTerminalControls && styles.tailToggleActive]}
              onPress={() => setShowTerminalControls((current) => !current)}
            >
              <Text
                style={[
                  styles.fullscreenPillText,
                  showTerminalControls && styles.tailToggleTextActive,
                ]}
              >
                Tmux
              </Text>
            </Pressable>
            <TerminalOrientationButton controls={orientationControls} />
            <Pressable style={styles.fullscreenPill} onPress={toggleTerminalFullscreen}>
              <Text style={styles.fullscreenPillText}>Exit</Text>
            </Pressable>
          </View>
          <TerminalFullscreenWorkspaceRail
            top={insets.top + 46}
            slotId={slotId}
            run={targetRun}
            fallbackRunId={runId}
            recipeRunId={workspaceRecipeRunId}
            recipeAvailable={targetRecipeAvailable}
            diffAvailable={targetDiffAvailable}
            diffArtifactPath={targetDiffArtifactPath}
            focusedArtifactPath={requestedArtifactPath || null}
            visualPairCount={targetPriorityVisualPairs.length}
            compareArtifactPath={targetPriorityVisualPair?.after.path ?? null}
            compareRecipeRunId={targetCompareRecipeRunId}
            readyDecisionId={readyDecision?.id ?? null}
            reviewDecisionId={reviewGateDecision?.id ?? null}
            retroDecisionId={retroDecision?.id ?? null}
            activeTaskProgress={activeTaskProgress}
            fallbackTaskProgress={fallbackTaskProgress}
            workspaceRouteContext={workspaceRouteContext}
          />
        </>
      ) : null}
      {!terminalFullscreen && (
        <ScrollView
          style={[styles.header, { maxHeight: terminalHeaderMaxHeight }]}
          contentContainerStyle={styles.headerContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator={showTerminalOptions}
        >
          <View style={styles.terminalCompactHeader}>
            <Pressable style={styles.backButton} onPress={goBackOrHome}>
              <Text style={styles.backButtonText}>‹</Text>
            </Pressable>
            <View style={styles.terminalIdentity}>
              <Text style={styles.terminalTarget} numberOfLines={1}>
                {slotId ?? 'unknown slot'}
              </Text>
              <Text style={styles.terminalMeta} numberOfLines={1}>
                {lines.length} lines · {formatSnapshotTime(lastUpdated)}
                {targetRun?.status ? ` · ${targetRun.status}` : ''}
              </Text>
            </View>
            <Pressable
              style={[styles.tailToggle, showTerminalOptions && styles.tailToggleActive]}
              onPress={() => setShowTerminalOptions((current) => !current)}
            >
              <Text
                style={[styles.tailToggleText, showTerminalOptions && styles.tailToggleTextActive]}
              >
                Tail {lineCount}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.tailToggle, showTerminalControls && styles.tailToggleActive]}
              onPress={() => setShowTerminalControls((current) => !current)}
            >
              <Text
                style={[styles.tailToggleText, showTerminalControls && styles.tailToggleTextActive]}
              >
                Tmux
              </Text>
            </Pressable>
            <Pressable style={styles.tailToggle} onPress={toggleTerminalFullscreen}>
              <Ionicons name="expand-outline" size={16} color={colors.textSecondary} />
            </Pressable>
            <View
              style={[
                styles.liveBadge,
                {
                  backgroundColor: liveBadgeColor + '20',
                  borderColor: liveBadgeColor + '80',
                },
              ]}
            >
              <Text style={[styles.liveBadgeText, { color: liveBadgeColor }]}>{streamLabel}</Text>
            </View>
          </View>

          <TerminalSteeringContextCard
            slotId={slotId} run={targetRun} fallbackRunId={runId}
            streamLabel={streamLabel} liveBadgeColor={liveBadgeColor}
            targetWarning={targetWarning} terminalInputDisabled={Boolean(terminalInputDisabledReason)}
            voiceRecorderBusy={voiceRecorderBusy} onOpenTmux={() => setShowTerminalControls(true)}
            onOpenContext={() => setShowTerminalOptions(true)} onOpenVoice={handleFloatingVoicePress}
            onOpenKeyboard={() => { setAllowTerminalTouchKeyboard(true); setShowTerminalControls(true); }}
          />

          {showTerminalOptions && (
            <View style={styles.terminalOptionsPanel}>
              <View style={styles.lineCountRow}>
                <Text style={styles.selectorLabel}>Tail</Text>
                {LINE_COUNT_OPTIONS.map((count) => (
                  <Pressable
                    key={count}
                    style={[styles.selectorChip, lineCount === count && styles.selectorChipActive]}
                    onPress={() => {
                      setLineCount(count);
                    }}
                  >
                    <Text
                      style={[
                        styles.selectorChipText,
                        lineCount === count && styles.selectorChipTextActive,
                      ]}
                    >
                      {count}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.statusRow}>
                {targetRun?.ticketOrPr && (
                  <Text style={styles.statusText} numberOfLines={1}>
                    Run: {targetRun.ticketOrPr}
                  </Text>
                )}
                {runId && <Text style={styles.statusText}>Run id: {runId}</Text>}
                {targetRun?.flowType && (
                  <Text style={styles.statusText}>Flow: {targetRun.flowType}</Text>
                )}
                {snapshotRole && <Text style={styles.statusText}>Role: {snapshotRole}</Text>}
                {targetRun?.branch && (
                  <Text style={styles.statusText} numberOfLines={1}>
                    Branch: {targetRun.branch}
                  </Text>
                )}
                {targetRun?.metrics?.model && (
                  <Text style={styles.statusText}>Model: {targetRun.metrics.model}</Text>
                )}
              </View>
              {snapshotContextId && (
                <Text style={styles.contextText} numberOfLines={1}>
                  Context: {snapshotContextId}
                </Text>
              )}
            </View>
          )}

          <RunWorkspaceNav
            current="terminal"
            dense
            routeWorkspace={workspaceRouteContext.workspace}
            routeDecisionKind={workspaceRouteContext.decisionKind}
            decisionId={primaryDecision?.id ?? null}
            decisionKind={workspaceDecisionKind(primaryDecision)}
            readyDecisionId={readyDecision?.id ?? null}
            reviewDecisionId={reviewGateDecision?.id ?? null}
            retroDecisionId={retroDecision?.id ?? null}
            readyMeta={workspaceNavMeta.readyMeta}
            reviewMeta={workspaceNavMeta.reviewMeta}
            retroMeta={workspaceNavMeta.retroMeta}
            familyId={targetRun?.familyId}
            project={targetRun?.project}
            prNumber={targetRun?.prNumber}
            prRepo={prRepoFromWorkspaceSource(targetRun, targetRun?.prNumber ?? null)}
            recipeRunId={workspaceRecipeRunId}
            slotId={slotId}
            runId={targetRun?.id ?? runId}
            artifactPath={requestedArtifactPath || targetDiffArtifactPath}
            recipeAvailable={targetRecipeAvailable}
            recipeArtifactCount={targetRecipeArtifactCount}
            diffAvailable={targetDiffAvailable}
            artifactCount={targetArtifactCount}
            visualPairCount={targetPriorityVisualPairs.length}
            compareArtifactPath={targetPriorityVisualPair?.after.path ?? null}
            compareRecipeRunId={targetCompareRecipeRunId}
          />

          {showTerminalOptions && (
            <TerminalWorkspaceCockpit
              slotId={slotId}
              run={targetRun}
              fallbackRunId={runId}
              recipeRunId={workspaceRecipeRunId}
              focusedArtifactPath={requestedArtifactPath || null}
              artifactCount={targetArtifactCount}
              visualPairCount={targetPriorityVisualPairs.length}
              comparePair={targetPriorityVisualPair}
              compareArtifactPath={targetPriorityVisualPair?.after.path ?? null}
              compareRecipeRunId={targetCompareRecipeRunId}
              artifactAuthHeaders={artifactAuthHeaders}
              recipeArtifactCount={targetRecipeArtifactCount}
              recipeAvailable={targetRecipeAvailable}
              diffArtifactPath={targetDiffArtifactPath}
              diffAvailable={targetDiffAvailable}
              readyDecisionId={readyDecision?.id ?? null}
              reviewDecisionId={reviewGateDecision?.id ?? null}
              retroDecisionId={retroDecision?.id ?? null}
              streamLabel={streamLabel}
              lineCount={lines.length}
              lastUpdatedLabel={formatSnapshotTime(lastUpdated)}
              activeTaskProgress={activeTaskProgress}
              fallbackTaskProgress={fallbackTaskProgress}
              workspaceRouteContext={workspaceRouteContext}
            />
          )}

          {showTerminalOptions && activeTaskProgress ? (
            <View style={styles.terminalProgressPanel}>
              <TaskProgressPanel
                run={targetRun}
                progress={activeTaskProgress}
                error={taskProgressError}
                compact
              />
            </View>
          ) : showTerminalOptions && fallbackTaskProgress ? (
            <View style={styles.terminalProgressPanel}>
              <TaskProgressFallbackPanel
                summary={fallbackTaskProgress}
                error={taskProgressError}
                compact
              />
            </View>
          ) : null}

          {snapshotError && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{snapshotError}</Text>
            </View>
          )}
          {targetWarning && (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>{targetWarning}</Text>
              <Pressable style={styles.retryButton} onPress={refreshTargetRun}>
                <Text style={styles.warningRetryText}>Recheck</Text>
              </Pressable>
            </View>
          )}
          {targetRecipeAvailabilityError && (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>{targetRecipeAvailabilityError}</Text>
            </View>
          )}
        </ScrollView>
      )}

      <View style={styles.terminalArea}>
        <XtermTerminalView
          ref={terminalViewRef}
          allowTouchKeyboard={allowTerminalTouchKeyboard}
          initialText={lines.join('\r\n')}
          onInput={handleTerminalInput}
          onResize={handleTerminalResize}
          readOnlyReason={terminalInputDisabledReason}
        />
      </View>

      {!terminalInputDisabledReason && showVoiceComposer && (
        <View
          style={[
            styles.voicePanel,
            !showInputBar && { paddingBottom: spacing.sm + insets.bottom },
          ]}
          onLayout={(event) => setVoicePanelWidth(event.nativeEvent.layout.width)}
        >
          {showVoiceWaveformSurface ? (
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
              testID="voice-copilot-record-widget"
            />
          ) : (
            <View style={styles.voiceComposerRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  hasVoiceEditableInstruction ? 'Retake dictation' : 'Dictate instruction'
                }
                accessibilityHint={voiceMessage || undefined}
                style={[
                  styles.voiceInlineMicButton,
                  voiceRecorderBusy && styles.floatingVoiceButtonBusy,
                ]}
                onPress={handleFloatingVoicePress}
                disabled={voiceRecorderBusy}
              >
                <Ionicons
                  name={voiceRecorderBusy ? 'ellipsis-horizontal' : 'mic-outline'}
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
                    setVoiceTargetSuggestion(null);
                  }}
                  placeholder={
                    voiceRuntimePending
                      ? 'Checking voice…'
                      : voiceRuntimeUnavailable
                        ? 'Voice unavailable; type instruction…'
                        : voiceModelNeedsSetup
                          ? 'Download transcription, or type…'
                          : 'Say or type instruction…'
                  }
                  placeholderTextColor={colors.textMuted}
                  multiline
                  autoCapitalize="sentences"
                  editable={!voiceInputLocked}
                />
              </View>
              {hasVoiceEditableInstruction && (
                <View style={styles.voiceActionStack}>
                  <Pressable
                    style={[
                      styles.voiceSendButton,
                      !canRunVoicePrimaryAction && styles.disabledButton,
                    ]}
                    onPress={voiceTargetMismatchSlotId ? openVoiceTargetSuggestion : sendVoiceDraft}
                    disabled={!canRunVoicePrimaryAction}
                  >
                    <Text style={styles.voiceSendText}>
                      {voiceTargetMismatchSlotId
                        ? `Open ${voiceTargetMismatchSlotId}`
                        : isSending
                          ? '…'
                          : isFormattingVoice
                            ? 'Clean…'
                            : voiceTranscriptNeedsCleanup
                              ? 'Clean'
                              : 'Send'}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.voiceCancelButton} onPress={discardVoiceDraft}>
                    <Text style={styles.voiceCancelText}>Cancel</Text>
                  </Pressable>
                </View>
              )}
              {(voiceSetupAction.visible || canCloseEmptyVoiceComposer) &&
                !hasVoiceEditableInstruction && (
                  <View style={styles.voiceActionStack}>
                    {voiceSetupAction.visible ? (
                      <Pressable
                        style={[
                          styles.voiceSendButton,
                          (!voiceSetupAction.enabled || isDownloadingVoiceModel) &&
                            styles.disabledButton,
                        ]}
                        onPress={downloadSelectedVoiceModel}
                        disabled={!voiceSetupAction.enabled || isDownloadingVoiceModel}
                      >
                        <Text style={styles.voiceSendText}>{voiceSetupAction.label}</Text>
                      </Pressable>
                    ) : null}
                    {canCloseEmptyVoiceComposer ? (
                      <Pressable style={styles.voiceCancelButton} onPress={closeEmptyVoiceComposer}>
                        <Text style={styles.voiceCancelText}>Close</Text>
                      </Pressable>
                    ) : null}
                  </View>
                )}
            </View>
          )}
          {showVoiceProgressText ? (
            <Text style={styles.voiceProgressText} accessibilityLiveRegion="polite">
              {voiceMessage}
            </Text>
          ) : null}
          {voiceWarning && <Text style={styles.voiceWarningText}>{voiceWarning}</Text>}
        </View>
      )}

      {showFloatingVoiceButton && (
        <Animated.View style={[styles.floatingVoiceShell, { bottom: floatingVoiceBottom }]}>
          {animateVoiceButton && (
            <Animated.View style={[styles.floatingVoicePulse, voiceButtonPulseStyle]} />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dictate instruction"
            accessibilityHint={voiceMessage || undefined}
            style={styles.floatingVoiceButton}
            onPress={handleFloatingVoicePress}
            disabled={false}
          >
            <Ionicons name="mic-outline" size={30} color="#fff" />
          </Pressable>
        </Animated.View>
      )}

      {showInputBar && (
        <View style={[styles.composer, { paddingBottom: spacing.sm + insets.bottom }]}>
          {showTerminalControls && (
            <View style={styles.controlPanel}>
              <TerminalControlKeyBar
                activeLabel={activeControlKey}
                disabled={isSendingControl}
                touchKeyboardEnabled={allowTerminalTouchKeyboard}
                onPress={(control) => void sendControlKey(control)}
                onToggleTouchKeyboard={() =>
                  setAllowTerminalTouchKeyboard(!allowTerminalTouchKeyboard)
                }
              />
              <TmuxControlPanel
                windows={tmuxWindows}
                activeAction={activeTmuxAction}
                disabled={connectionStatus !== 'connected' || Boolean(activeTmuxAction)}
                onRefresh={refreshTmuxWindows}
                onAction={runTmuxAction}
              />
            </View>
          )}
          {(controlError || tmuxError) && (
            <Text style={styles.sendErrorText}>{controlError ?? tmuxError}</Text>
          )}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
