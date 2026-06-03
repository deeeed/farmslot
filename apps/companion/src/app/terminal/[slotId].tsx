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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
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
import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
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
  type ArtifactHttpHeaders,
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
  taskProgressPercent,
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
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
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
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForDecisionEvidenceContext,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceForArtifactRoute,
  targetWorkspaceRouteContextParams,
  type WorkspaceRouteContext,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';
import { useTerminalPrefsStore } from '../../store/terminal-prefs';

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

function TerminalWorkspaceCockpit({
  slotId,
  run,
  fallbackRunId,
  recipeRunId,
  focusedArtifactPath,
  artifactCount,
  visualPairCount,
  comparePair,
  compareArtifactPath,
  compareRecipeRunId,
  artifactAuthHeaders,
  recipeArtifactCount,
  recipeAvailable,
  diffArtifactPath,
  diffAvailable,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  streamLabel,
  lineCount,
  lastUpdatedLabel,
  activeTaskProgress,
  fallbackTaskProgress,
  workspaceRouteContext,
}: {
  slotId: string;
  run: Run | null;
  fallbackRunId?: string;
  recipeRunId: string;
  focusedArtifactPath: string | null;
  artifactCount: number;
  visualPairCount: number;
  comparePair: VisualArtifactPair | null;
  compareArtifactPath: string | null;
  compareRecipeRunId: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffArtifactPath: string | null;
  diffAvailable?: boolean;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  streamLabel: string;
  lineCount: number;
  lastUpdatedLabel: string;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  workspaceRouteContext: WorkspaceRouteContext;
}) {
  const router = useRouter();
  const targetRunId = run?.id ?? fallbackRunId ?? null;
  const artifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const focusedArtifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    workspaceRouteContext.decisionKind,
  );
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const recipeTarget = recipeWorkspaceParam(recipeRunId);
  const openRun = () => {
    if (!targetRunId) return;
    router.push({
      pathname: '/run/[id]',
      params: {
        id: targetRunId,
        ...targetRouteContext('run'),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openScopedArtifacts = () => {
    if (!targetRunId) return;
    const targetFilter =
      artifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? artifactFilterParamForWorkspaceNav('recipe')
        : ((focusedArtifactPath ? artifactFilterParamForArtifactPath(focusedArtifactPath) : null) ??
          artifactFilterParamForWorkspaceNav('review'));
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(artifactRecipeRun, targetFilter)),
        recipeRun: artifactRecipeRun,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        filter: targetFilter,
      },
    });
  };
  const openEvidenceArtifacts = () => {
    if (!targetRunId) return;
    const evidenceArtifactPath = shouldPreserveArtifactForDecisionEvidenceContext(
      focusedArtifactRecipeRun,
      focusedArtifactPath,
    )
      ? focusedArtifactPath
      : null;
    const targetFilter =
      (evidenceArtifactPath ? artifactFilterParamForArtifactPath(evidenceArtifactPath) : null) ??
      artifactFilterParamForWorkspaceNav('review');
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext(
          targetWorkspaceForArtifactRoute(DECISION_EVIDENCE_RECIPE_RUN_PARAM, targetFilter),
        ),
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter: targetFilter,
        ...(evidenceArtifactPath ? { artifact: evidenceArtifactPath } : {}),
      },
    });
  };
  const openCompareArtifacts = () => {
    if (!targetRunId || !compareArtifactPath) return;
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext('compare'),
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        artifact: compareArtifactPath,
      },
    });
  };
  const openCompareArtifact = (artifactPath: string) => {
    if (!targetRunId) return;
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext('compare'),
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        artifact: artifactPath,
      },
    });
  };
  const openRecipe = () => {
    if (!targetRunId || recipeAvailable === false) return;
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext('recipe'),
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
          ? { artifact: focusedArtifactPath }
          : {}),
      },
    });
  };
  const openDiff = () => {
    if (targetRunId && diffAvailable !== false) {
      router.push({
        pathname: '/diff/[runId]',
        params: {
          runId: targetRunId,
          ...diffRouteContext,
          ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
          ...(focusedArtifactIsDiff
            ? { path: focusedArtifactPath }
            : diffArtifactPath
              ? { path: diffArtifactPath }
              : {}),
        },
      });
      return;
    }
    router.push({
      pathname: '/diff/slot/[slotId]',
      params: {
        slotId,
        ...diffRouteContext,
        ...(focusedArtifactIsDiff
          ? { path: focusedArtifactPath }
          : diffArtifactPath
            ? { path: diffArtifactPath }
            : {}),
      },
    });
  };
  const openSlot = () => {
    router.push({
      pathname: '/slot/[id]',
      params: {
        id: slotId,
        ...targetRouteContext('slot'),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openFamily = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('focus', workspaceRouteContext.decisionKind),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'focus',
      },
    });
  };
  const openFamilyRetros = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'retros',
      },
    });
  };
  const openDecision = (decisionId: string | null) => {
    if (!decisionId) return;
    const decisionRouteContext = decisionWorkspaceRouteParams(
      decisionId === readyDecisionId
        ? 'ready'
        : decisionId === retroDecisionId
          ? 'retrospective'
          : 'review',
    );
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...decisionRouteContext,
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openFocusedArtifact = () => {
    if (!targetRunId || !focusedArtifactPath) return;
    if (focusedArtifactIsDiff) {
      openDiff();
      return;
    }
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext(
          targetWorkspaceForArtifactRoute(
            focusedArtifactRecipeRun,
            artifactFilterParamForArtifactPath(focusedArtifactPath) ??
              (focusedArtifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                ? artifactFilterParamForWorkspaceNav('recipe')
                : artifactFilterParamForWorkspaceNav('review')),
          ),
        ),
        recipeRun: focusedArtifactRecipeRun,
        artifact: focusedArtifactPath,
        filter:
          artifactFilterParamForArtifactPath(focusedArtifactPath) ??
          (focusedArtifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
            ? artifactFilterParamForWorkspaceNav('recipe')
            : artifactFilterParamForWorkspaceNav('review')),
      },
    });
  };
  const focusedArtifactKind = focusedArtifactPath
    ? terminalFocusedArtifactKindLabel(focusedArtifactPath)
    : null;
  const focusedArtifactRecipeScoped =
    focusedArtifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const openPR = () => {
    if (!run?.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...targetRouteContext('pr'),
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';

  return (
    <View style={styles.terminalCockpitPanel}>
      <View style={styles.terminalCockpitHeader}>
        <View style={styles.terminalCockpitTitleBlock}>
          <Text style={styles.terminalCockpitTitle}>Terminal cockpit</Text>
          <Text style={styles.terminalCockpitMeta} numberOfLines={1}>
            {run?.ticketOrPr ?? slotId} · {streamLabel}
          </Text>
        </View>
        <Pressable
          style={[styles.terminalCockpitPill, !targetRunId && styles.terminalCockpitDisabled]}
          disabled={!targetRunId}
          onPress={openRun}
        >
          <Text style={styles.terminalCockpitPillText}>Run</Text>
        </Pressable>
      </View>

      {focusedArtifactPath ? (
        <View style={styles.terminalFocusedArtifactCard}>
          <View style={styles.terminalCockpitHeader}>
            <View style={styles.terminalCockpitTitleBlock}>
              <Text style={styles.terminalFocusedArtifactEyebrow}>Focused artifact</Text>
              <Text style={styles.terminalFocusedArtifactPath} numberOfLines={2}>
                {focusedArtifactPath}
              </Text>
              <Text style={styles.terminalFocusedArtifactMeta} numberOfLines={1}>
                {focusedArtifactKind} ·{' '}
                {focusedArtifactRecipeScoped ? 'recipe context' : 'decision evidence'}
              </Text>
            </View>
            <Pressable
              style={[styles.terminalCockpitPill, !targetRunId && styles.terminalCockpitDisabled]}
              disabled={!targetRunId}
              onPress={openFocusedArtifact}
            >
              <Text style={styles.terminalCockpitPillText}>
                {focusedArtifactIsDiff ? 'Open diff' : 'Open'}
              </Text>
            </Pressable>
          </View>
          <View style={styles.terminalCockpitActions}>
            <Pressable
              style={[styles.terminalCockpitAction, !targetRunId && styles.terminalCockpitDisabled]}
              disabled={!targetRunId}
              onPress={openScopedArtifacts}
            >
              <Text style={styles.terminalCockpitActionText}>Files context</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                (!targetRunId || recipeAvailable === false) && styles.terminalCockpitDisabled,
              ]}
              disabled={!targetRunId || recipeAvailable === false}
              onPress={openRecipe}
            >
              <Text style={styles.terminalCockpitActionText}>Recipe files</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                (!targetRunId || visualPairCount === 0) && styles.terminalCockpitDisabled,
              ]}
              disabled={!targetRunId || visualPairCount === 0}
              onPress={openCompareArtifacts}
            >
              <Text style={styles.terminalCockpitActionText}>Before→After</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !targetRunId && !slotId && styles.terminalCockpitDisabled,
              ]}
              disabled={!targetRunId && !slotId}
              onPress={openDiff}
            >
              <Text style={styles.terminalCockpitActionText}>
                {focusedArtifactIsDiff ? 'Focused diff' : 'Run diff'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.terminalCockpitAction, !targetRunId && styles.terminalCockpitDisabled]}
              disabled={!targetRunId}
              onPress={openRun}
            >
              <Text style={styles.terminalCockpitActionText}>Run detail</Text>
            </Pressable>
            <Pressable style={styles.terminalCockpitAction} onPress={openSlot}>
              <Text style={styles.terminalCockpitActionText}>Slot</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !run?.familyId && styles.terminalCockpitDisabled,
              ]}
              disabled={!run?.familyId}
              onPress={openFamily}
            >
              <Text style={styles.terminalCockpitActionText}>Family</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !run?.familyId && styles.terminalCockpitDisabled,
              ]}
              disabled={!run?.familyId}
              onPress={openFamilyRetros}
            >
              <Text style={styles.terminalCockpitActionText}>Family retros</Text>
            </Pressable>
            <Pressable
              style={[
                styles.terminalCockpitAction,
                !run?.prNumber && styles.terminalCockpitDisabled,
              ]}
              disabled={!run?.prNumber}
              onPress={openPR}
            >
              <Text style={styles.terminalCockpitActionText}>PR</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={styles.terminalCockpitCompactRow}>
        <Text style={styles.terminalCockpitCompactMeta} numberOfLines={1}>
          Tail {lineCount} · {lastUpdatedLabel}
        </Text>
        <Text style={styles.terminalCockpitCompactMeta} numberOfLines={1}>
          Files {artifactCount} · Recipe {recipeArtifactCount ?? '-'}
        </Text>
        <Text style={styles.terminalCockpitCompactMeta} numberOfLines={1}>
          Progress {progressValue}
        </Text>
      </View>

      <View style={styles.terminalCockpitActions}>
        <Pressable
          style={[styles.terminalCockpitAction, !targetRunId && styles.terminalCockpitDisabled]}
          disabled={!targetRunId}
          onPress={openEvidenceArtifacts}
        >
          <Text style={styles.terminalCockpitActionText}>Files</Text>
        </Pressable>
        <Pressable
          style={[
            styles.terminalCockpitAction,
            (!targetRunId || recipeAvailable === false) && styles.terminalCockpitDisabled,
          ]}
          disabled={!targetRunId || recipeAvailable === false}
          onPress={openRecipe}
        >
          <Text style={styles.terminalCockpitActionText}>Recipe</Text>
        </Pressable>
        <Pressable
          style={[
            styles.terminalCockpitAction,
            !targetRunId && !slotId && styles.terminalCockpitDisabled,
          ]}
          disabled={!targetRunId && !slotId}
          onPress={openDiff}
        >
          <Text style={styles.terminalCockpitActionText}>Diff</Text>
        </Pressable>
        <Pressable style={styles.terminalCockpitAction} onPress={openSlot}>
          <Text style={styles.terminalCockpitActionText}>Slot</Text>
        </Pressable>
        <Pressable
          style={[styles.terminalCockpitAction, !readyDecisionId && styles.terminalCockpitDisabled]}
          disabled={!readyDecisionId}
          onPress={() => openDecision(readyDecisionId)}
        >
          <Text style={styles.terminalCockpitActionText}>Ready</Text>
        </Pressable>
        <Pressable
          style={[
            styles.terminalCockpitAction,
            !reviewDecisionId && styles.terminalCockpitDisabled,
          ]}
          disabled={!reviewDecisionId}
          onPress={() => openDecision(reviewDecisionId)}
        >
          <Text style={styles.terminalCockpitActionText}>Review</Text>
        </Pressable>
        <Pressable
          style={[styles.terminalCockpitAction, !run?.familyId && styles.terminalCockpitDisabled]}
          disabled={!run?.familyId}
          onPress={openFamily}
        >
          <Text style={styles.terminalCockpitActionText}>Family</Text>
        </Pressable>
        <Pressable
          style={[styles.terminalCockpitAction, !run?.prNumber && styles.terminalCockpitDisabled]}
          disabled={!run?.prNumber}
          onPress={openPR}
        >
          <Text style={styles.terminalCockpitActionText}>PR</Text>
        </Pressable>
      </View>

      {comparePair ? (
        <BeforeAfterPreview
          pair={comparePair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={openCompareArtifact}
          eyebrow={
            compareRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
              ? 'Run evidence'
              : 'Recipe evidence'
          }
          title={
            compareRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
              ? 'Terminal before → after'
              : 'Recipe before → after'
          }
          hint="Tap to inspect"
          imageHeight={66}
        />
      ) : null}
    </View>
  );
}

function TerminalFullscreenWorkspaceRail({
  top,
  slotId,
  run,
  fallbackRunId,
  recipeRunId,
  recipeAvailable,
  diffAvailable,
  diffArtifactPath,
  focusedArtifactPath,
  visualPairCount,
  compareArtifactPath,
  compareRecipeRunId,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  activeTaskProgress,
  fallbackTaskProgress,
  workspaceRouteContext,
}: {
  top: number;
  slotId: string;
  run: Run | null;
  fallbackRunId?: string;
  recipeRunId: string;
  recipeAvailable?: boolean;
  diffAvailable?: boolean;
  diffArtifactPath: string | null;
  focusedArtifactPath: string | null;
  visualPairCount: number;
  compareArtifactPath: string | null;
  compareRecipeRunId: string;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  workspaceRouteContext: WorkspaceRouteContext;
}) {
  const router = useRouter();
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const targetRunId = run?.id ?? fallbackRunId ?? null;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    workspaceRouteContext.decisionKind,
  );
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const openSlot = () => {
    router.push({
      pathname: '/slot/[id]',
      params: {
        id: slotId,
        ...targetRouteContext('slot'),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openRun = () => {
    if (!targetRunId) return;
    router.push({
      pathname: '/run/[id]',
      params: {
        id: targetRunId,
        ...targetRouteContext('run'),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openScopedArtifacts = () => {
    if (!targetRunId) return;
    const artifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    const targetFilter =
      artifactRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? artifactFilterParamForWorkspaceNav('recipe')
        : ((focusedArtifactPath ? artifactFilterParamForArtifactPath(focusedArtifactPath) : null) ??
          artifactFilterParamForWorkspaceNav('review'));
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(artifactRecipeRun, targetFilter)),
        recipeRun: artifactRecipeRun,
        filter: targetFilter,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openEvidenceArtifacts = () => {
    if (!targetRunId) return;
    const focusedArtifactRecipeRun = recipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    const evidenceArtifactPath = shouldPreserveArtifactForDecisionEvidenceContext(
      focusedArtifactRecipeRun,
      focusedArtifactPath,
    )
      ? focusedArtifactPath
      : null;
    const targetFilter =
      (evidenceArtifactPath ? artifactFilterParamForArtifactPath(evidenceArtifactPath) : null) ??
      artifactFilterParamForWorkspaceNav('review');
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext(
          targetWorkspaceForArtifactRoute(DECISION_EVIDENCE_RECIPE_RUN_PARAM, targetFilter),
        ),
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter: targetFilter,
        ...(evidenceArtifactPath ? { artifact: evidenceArtifactPath } : {}),
      },
    });
  };
  const openCompare = () => {
    if (!targetRunId || !compareArtifactPath || visualPairCount === 0) return;
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext('compare'),
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        artifact: compareArtifactPath,
      },
    });
  };
  const openRecipe = () => {
    if (!targetRunId || recipeAvailable === false) return;
    const recipeTarget = recipeWorkspaceParam(recipeRunId);
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: targetRunId,
        ...targetRouteContext('recipe'),
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
          ? { artifact: focusedArtifactPath }
          : {}),
      },
    });
  };
  const openDiff = () => {
    if (targetRunId && diffAvailable !== false) {
      router.push({
        pathname: '/diff/[runId]',
        params: {
          runId: targetRunId,
          ...diffRouteContext,
          ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
          ...(focusedArtifactIsDiff
            ? { path: focusedArtifactPath }
            : diffArtifactPath
              ? { path: diffArtifactPath }
              : {}),
        },
      });
      return;
    }
    router.push({
      pathname: '/diff/slot/[slotId]',
      params: {
        slotId,
        ...diffRouteContext,
        ...(focusedArtifactIsDiff ? { path: focusedArtifactPath } : {}),
      },
    });
  };
  const openFamily = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('focus', workspaceRouteContext.decisionKind),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'focus',
      },
    });
  };
  const openFamilyRetros = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        section: 'retros',
      },
    });
  };
  const openPR = () => {
    if (!run?.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...targetRouteContext('pr'),
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const openDecision = (decisionId: string | null) => {
    if (!decisionId) return;
    const decisionRouteContext = decisionWorkspaceRouteParams(
      decisionId === readyDecisionId
        ? 'ready'
        : decisionId === retroDecisionId
          ? 'retrospective'
          : 'review',
    );
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...decisionRouteContext,
        ...(targetRunId ? { runId: targetRunId } : {}),
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openFocusedArtifact = () => {
    if (focusedArtifactIsDiff) {
      openDiff();
      return;
    }
    openScopedArtifacts();
  };
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';

  return (
    <View style={[styles.fullscreenWorkspaceRail, { top }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.fullscreenWorkspaceRailContent}
      >
        <FullscreenNavPill label="Slot" value={slotId} onPress={openSlot} />
        <FullscreenNavPill
          label="Run"
          value={targetRunId ? 'detail' : '-'}
          onPress={openRun}
          disabled={!targetRunId}
        />
        {focusedArtifactPath ? (
          <FullscreenNavPill
            label="Focus"
            value={focusedArtifactIsDiff ? 'diff' : 'artifact'}
            onPress={openFocusedArtifact}
            disabled={!targetRunId && !focusedArtifactIsDiff}
          />
        ) : null}
        <FullscreenNavPill
          label="Evidence"
          value={targetRunId ? 'files' : '-'}
          onPress={openEvidenceArtifacts}
          disabled={!targetRunId}
        />
        {visualPairCount > 0 ? (
          <FullscreenNavPill
            label="Compare"
            value={`${visualPairCount}`}
            onPress={openCompare}
            disabled={!targetRunId || !compareArtifactPath}
          />
        ) : null}
        <FullscreenNavPill
          label="Recipe"
          value={recipeAvailable === false ? '-' : recipeScopeLabel}
          onPress={openRecipe}
          disabled={!targetRunId || recipeAvailable === false}
        />
        <FullscreenNavPill
          label="Diff"
          value={diffAvailable === false ? 'slot' : 'run'}
          onPress={openDiff}
        />
        <FullscreenNavPill
          label="Progress"
          value={progressValue}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
        />
        {readyDecisionId ? (
          <FullscreenNavPill
            label="Ready"
            value={workspaceNavMeta.readyMeta ?? 'gate'}
            onPress={() => openDecision(readyDecisionId)}
          />
        ) : null}
        {reviewDecisionId ? (
          <FullscreenNavPill
            label="Review"
            value={workspaceNavMeta.reviewMeta ?? 'gate'}
            onPress={() => openDecision(reviewDecisionId)}
          />
        ) : null}
        {retroDecisionId ? (
          <FullscreenNavPill
            label="Retro"
            value={workspaceNavMeta.retroMeta ?? 'gate'}
            onPress={() => openDecision(retroDecisionId)}
          />
        ) : null}
        <FullscreenNavPill
          label="Family"
          value={run?.familyId ? 'open' : '-'}
          onPress={openFamily}
          disabled={!run?.familyId}
        />
        <FullscreenNavPill
          label="Family retros"
          value={run?.familyId ? 'open' : '-'}
          onPress={openFamilyRetros}
          disabled={!run?.familyId}
        />
        <FullscreenNavPill
          label="PR"
          value={run?.prNumber ? `#${run.prNumber}` : '-'}
          onPress={openPR}
          disabled={!run?.prNumber}
        />
      </ScrollView>
    </View>
  );
}

function FullscreenNavPill({
  label,
  value,
  onPress,
  disabled = false,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.fullscreenNavPillLabel}>{label}</Text>
      <Text style={styles.fullscreenNavPillValue} numberOfLines={1}>
        {value}
      </Text>
    </>
  );
  if (!onPress) {
    return (
      <View style={[styles.fullscreenNavPill, disabled && styles.fullscreenNavPillDisabled]}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      style={[styles.fullscreenNavPill, disabled && styles.fullscreenNavPillDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      {content}
    </Pressable>
  );
}

function terminalFocusedArtifactKindLabel(artifactPath: string): string {
  if (diffArtifactCandidate([{ path: artifactPath }])) return 'diff';
  const filter = artifactFilterParamForArtifactPath(artifactPath);
  if (filter === 'recipes') return 'recipe file';
  if (filter === 'visual') return 'visual evidence';
  return 'evidence file';
}

type MobileTmuxActionMethod =
  | typeof Methods.TMUX_SPLIT
  | typeof Methods.TMUX_SELECT_PANE
  | typeof Methods.TMUX_KILL_PANE
  | typeof Methods.TMUX_ZOOM_PANE
  | typeof Methods.TMUX_NEW_WINDOW
  | typeof Methods.TMUX_SELECT_WINDOW
  | typeof Methods.TMUX_SEND_KEYS
  | typeof Methods.TMUX_SYNCHRONIZE_PANES;

function TmuxControlPanel({
  windows,
  activeAction,
  disabled,
  onRefresh,
  onAction,
}: {
  windows: TmuxWindow[];
  activeAction: string | null;
  disabled: boolean;
  onRefresh: () => void;
  onAction: (
    label: string,
    method: MobileTmuxActionMethod,
    params?: Record<string, unknown>,
  ) => void;
}) {
  const activeWindow = windows.find((window) => window.active) ?? null;
  const activePaneCount = activeWindow?.panes.length ?? 0;
  const activeSyncEnabled = Boolean(activeWindow?.synchronizePanes);
  const actionDisabled = disabled || Boolean(activeAction);
  const renderTmuxButton = (
    label: string,
    method: MobileTmuxActionMethod,
    params: Record<string, unknown> = {},
    danger = false,
  ) => (
    <Pressable
      key={label}
      style={[
        styles.controlButton,
        styles.tmuxButton,
        danger && styles.interruptButton,
        actionDisabled && styles.disabledButton,
      ]}
      disabled={actionDisabled}
      onPress={() => onAction(label, method, params)}
    >
      <Text style={[styles.controlButtonText, danger && styles.interruptButtonText]}>
        {activeAction === label ? '…' : label}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.tmuxPanel}>
      <View style={styles.tmuxPanelHeader}>
        <Text style={styles.controlLabel}>
          Tmux panes / windows{' '}
          {activeWindow
            ? `· ${activeWindow.name} · ${activePaneCount} pane${activePaneCount === 1 ? '' : 's'}${
                activeSyncEnabled ? ' · sync on' : ''
              }`
            : ''}
        </Text>
        <Pressable style={styles.tmuxRefreshButton} onPress={onRefresh} disabled={actionDisabled}>
          <Text style={styles.tmuxRefreshText}>Refresh</Text>
        </Pressable>
      </View>
      <View style={styles.controlRow}>
        {renderTmuxButton('Split →', Methods.TMUX_SPLIT, { direction: 'h' })}
        {renderTmuxButton('Split ↓', Methods.TMUX_SPLIT, { direction: 'v' })}
        {renderTmuxButton('Pane ↑', Methods.TMUX_SELECT_PANE, { direction: 'U' })}
        {renderTmuxButton('Pane ↓', Methods.TMUX_SELECT_PANE, { direction: 'D' })}
        {renderTmuxButton('Pane ←', Methods.TMUX_SELECT_PANE, { direction: 'L' })}
        {renderTmuxButton('Pane →', Methods.TMUX_SELECT_PANE, { direction: 'R' })}
        {renderTmuxButton('Zoom', Methods.TMUX_ZOOM_PANE)}
        {renderTmuxButton(
          activeSyncEnabled ? 'Sync panes off' : 'Sync panes on',
          Methods.TMUX_SYNCHRONIZE_PANES,
          {
            enabled: !activeSyncEnabled,
          },
        )}
        {renderTmuxButton('New win', Methods.TMUX_NEW_WINDOW)}
        {renderTmuxButton('Prefix', Methods.TMUX_SEND_KEYS, { keys: 'C-b' })}
        {renderTmuxButton('Kill pane', Methods.TMUX_KILL_PANE, {}, true)}
      </View>
      {windows.length > 0 ? (
        <View style={styles.controlRow}>
          {windows.map((window) => (
            <Pressable
              key={window.index}
              style={[
                styles.controlButton,
                styles.tmuxWindowButton,
                window.active && styles.tmuxWindowButtonActive,
                actionDisabled && styles.disabledButton,
              ]}
              disabled={actionDisabled}
              onPress={() =>
                onAction(`Win ${window.index}`, Methods.TMUX_SELECT_WINDOW, {
                  index: window.index,
                })
              }
            >
              <Text
                style={[
                  styles.controlButtonText,
                  window.active && styles.tmuxWindowButtonTextActive,
                ]}
                numberOfLines={1}
              >
                {activeAction === `Win ${window.index}`
                  ? '…'
                  : `${window.index}:${window.name || 'window'}${
                      window.panes.length > 1 ? `/${window.panes.length}` : ''
                    }`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreenContainer: {
    backgroundColor: '#000',
  },
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
  fullscreenIdentity: {
    flex: 1,
    minWidth: 0,
  },
  fullscreenTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  fullscreenMeta: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 1,
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
  fullscreenWorkspaceRail: {
    left: spacing.sm,
    position: 'absolute',
    right: spacing.sm,
    zIndex: 19,
  },
  fullscreenWorkspaceRailContent: {
    gap: spacing.xs,
    paddingRight: spacing.md,
  },
  fullscreenNavPill: {
    backgroundColor: 'rgba(18, 18, 28, 0.84)',
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    minWidth: 72,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  fullscreenNavPillDisabled: {
    opacity: 0.44,
  },
  fullscreenNavPillLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  fullscreenNavPillValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 1,
  },
  header: {
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
  },
  headerContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  terminalCompactHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  backButtonText: {
    color: colors.textPrimary,
    fontSize: 30,
    fontWeight: '600',
    lineHeight: 30,
  },
  terminalIdentity: {
    flex: 1,
    minWidth: 0,
  },
  terminalTarget: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  terminalMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  terminalOptionsPanel: {
    gap: spacing.sm,
  },
  terminalProgressPanel: {
    marginTop: spacing.sm,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
  },
  contextText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  terminalCockpitPanel: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '33',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  terminalCockpitHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  terminalCockpitTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  terminalCockpitTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  terminalCockpitMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  terminalCockpitPill: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  terminalCockpitPillText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  terminalCockpitCompactRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  terminalCockpitCompactMeta: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    minWidth: 0,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  terminalCockpitActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  terminalCockpitAction: {
    backgroundColor: colors.accent + '14',
    borderColor: colors.accent + '44',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  terminalCockpitActionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  terminalCockpitDisabled: {
    opacity: 0.45,
  },
  terminalFocusedArtifactCard: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  terminalFocusedArtifactEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  terminalFocusedArtifactPath: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  terminalFocusedArtifactMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  liveBadge: {
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    justifyContent: 'center',
  },
  liveBadgeText: {
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  tailToggle: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  tailToggleActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  tailToggleText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  tailToggleTextActive: {
    color: colors.accent,
  },
  lineCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  selectorLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    marginRight: spacing.xs,
  },
  selectorChip: {
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  selectorChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  selectorChipText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
  },
  selectorChipTextActive: {
    color: '#fff',
  },
  errorBox: {
    backgroundColor: colors.statusFail + '20',
    borderColor: colors.statusFail + '60',
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  warningBox: {
    backgroundColor: colors.statusWarn + '18',
    borderColor: colors.statusWarn + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  warningText: {
    color: colors.statusWarn,
    flex: 1,
    fontSize: fonts.sizeSm,
  },
  warningRetryText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  errorText: {
    color: colors.statusFail,
    flex: 1,
    fontSize: fonts.sizeSm,
  },
  retryButton: {
    alignSelf: 'center',
  },
  terminalArea: {
    flex: 1,
    backgroundColor: '#000',
  },
  composer: {
    backgroundColor: colors.bgSurface,
    borderTopWidth: 1,
    borderTopColor: colors.bgCard,
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  voicePanel: {
    backgroundColor: colors.bgSurface,
    borderTopWidth: 1,
    borderTopColor: colors.bgCard,
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  voiceComposerRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  voiceInputSurface: {
    flex: 1,
    minWidth: 0,
  },
  voiceInlineMicButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderColor: '#ffffff33',
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 58,
    width: 48,
  },
  voiceTextInput: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    minHeight: 58,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  voiceTextInputLocked: {
    opacity: 0.72,
  },
  voiceActionStack: {
    gap: spacing.xs,
    width: 72,
  },
  voiceSendButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: spacing.sm,
  },
  voiceCancelButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 22,
    paddingHorizontal: spacing.xs,
  },
  voiceWarningText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
  },
  voiceProgressText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  voiceSendText: {
    color: '#fff',
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textAlign: 'center',
  },
  voiceCancelText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textAlign: 'center',
  },
  floatingVoiceShell: {
    alignItems: 'center',
    height: 68,
    justifyContent: 'center',
    position: 'absolute',
    right: spacing.lg,
    width: 68,
  },
  floatingVoicePulse: {
    backgroundColor: colors.statusFail,
    borderRadius: 38,
    height: 76,
    position: 'absolute',
    width: 76,
  },
  floatingVoiceButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderColor: '#ffffff33',
    borderRadius: 31,
    borderWidth: 1,
    height: 62,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    width: 62,
  },
  floatingVoiceButtonBusy: {
    opacity: 0.72,
  },
  controlPanel: {
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  controlLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  controlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  controlButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCard + '99',
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    flexGrow: 1,
    justifyContent: 'center',
    minWidth: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  interruptButton: {
    backgroundColor: colors.statusFail + '20',
    borderColor: colors.statusFail + '70',
  },
  controlButtonText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textAlign: 'center',
  },
  tmuxPanel: {
    borderTopColor: colors.bgCard,
    borderTopWidth: 1,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  tmuxPanelHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  tmuxButton: {
    minWidth: 72,
  },
  tmuxRefreshButton: {
    backgroundColor: colors.bgCard + '99',
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  tmuxRefreshText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  tmuxWindowButton: {
    minWidth: 86,
  },
  tmuxWindowButtonActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  tmuxWindowButtonTextActive: {
    color: colors.accent,
  },
  interruptButtonText: {
    color: colors.statusFail,
  },
  sendErrorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
  },
  disabledButton: {
    opacity: 0.5,
  },
});
