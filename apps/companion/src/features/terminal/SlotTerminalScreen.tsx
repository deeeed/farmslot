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
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
  AGENT_ROLES,
  type CopilotFormatInstructionResult,
  extractRunArtifactManifest,
  Methods,
  type Run,
  type RunRecipeRunsForRunResult,
  type TaskProgressResult,
  type TerminalData,
  type TerminalSnapshotResult,
  type TmuxListResult,
  type TmuxWindow,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import {
  listSlotTmuxWindows,
  type OperatorMessageInput,
  operatorMessageInput,
  slotTmuxWindowTarget,
} from '@farmslot/review-dispatch';

import voiceAsrTestClipAssetModule from '../../../assets/asr/voice-command-status.wav';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { TaskProgressPanel } from '../../components/TaskProgressPanel';
import { TerminalControlKeyBar } from '../../components/TerminalControlKeyBar';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import { ensureMicrophonePermission } from '../../lib/audio-permissions';
import { diffArtifactCandidate } from '../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { getResourceCache } from '../../lib/resource-cache';
import {
  hasRunWorkspaceDiff,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isSlotWorkerProgressActive,
  isWorkerProgressActive,
  taskProgressRequestForRun,
} from '../../lib/task-progress';
import { slotTerminalRunnerPane, type TerminalControlKey } from '../../lib/terminal-controls';
import { TerminalInputCancelledError } from '../../lib/terminal-input-queue';
import { useTerminalOrientationControls } from '../../lib/terminal-orientation';
import { appendTerminalTailText, terminalTailLinesFromText } from '../../lib/terminal-tail';
import {
  buildCompanionTerminalTarget,
  type CompanionTerminalTargetParams,
  matchesCompanionTerminalTarget,
  targetWarningForRun,
} from '../../lib/terminal-target';
import { terminalTextRequest } from '../../lib/terminal-text-request';
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
import { useQuickActionVoiceTarget } from '../quick-actions/QuickActionsProvider';
import { useQuickActionComposerInset } from '../quick-actions/use-quick-action-composer-inset';
import { useSlotWorkspaceTabs } from '../workspace-shared/slot-workspace-tabs';

import {
  type MobileTmuxActionMethod,
  SlotTerminalSessionPane,
  TerminalFullscreenWorkspaceRail,
  TerminalSteeringContextCard,
  TerminalWorkspaceCockpit,
  TmuxControlPanel,
} from './components/slot-terminal-panels';
import {
  SlotTerminalCompactViewControls,
  SlotTerminalFullscreenViewControls,
} from './components/slot-terminal-view-controls';
import {
  type TerminalSize,
  type XtermTerminalViewHandle,
} from './components/terminal-history-viewer';
import { slotTerminalStyles as styles } from './styles/slot-terminal.styles';
import { useTerminalInput } from './use-terminal-input';
import { useTerminalProof, useTerminalRunContext } from './use-terminal-run-context';

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

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
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
  const pendingOperatorMessage = useRef<OperatorMessageInput | null>(null);
  const {
    slotId: requestedSlotId,
    runId,
    contextId,
    role: roleParam,
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
    slotId?: string;
    runId?: string;
    contextId?: string;
    role?: string;
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
  const focused = useIsFocused();
  const slotId = requestedSlotId ?? '';
  const role = AGENT_ROLES.find((candidate) => candidate === roleParam);
  const insideSlotWorkspaceTabs = useSlotWorkspaceTabs();
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
  const [terminalViewMode, setTerminalViewMode] = useState<'tmux' | 'history'>('tmux');
  const [terminalFullscreen, setTerminalFullscreen] = useState(
    routeParamString(fullscreenParam) === '1',
  );
  const orientationControls = useTerminalOrientationControls(terminalFullscreen);
  const terminalContext = useTerminalRunContext({ slotId, runId, contextId, role });
  const targetRun = terminalContext.targetRun;
  const native = terminalContext.native;
  const targetWarning =
    terminalContext.run.error?.message ??
    terminalContext.slot.error?.message ??
    (targetRun ? targetWarningForRun(targetRun, slotId) : null);
  const targetRecipeRuns = terminalContext.recipes.data?.recipeRuns ?? [];
  const targetRecipeArtifactCount = terminalContext.recipes.data
    ? targetRecipeRuns.reduce((count, group) => count + artifactsForRecipeRun(group).length, 0)
    : null;
  const targetRecipeAvailabilityError = terminalContext.recipes.error?.message ?? null;
  const progressQuery = useMemo(() => {
    const target = taskProgressRequestForRun(targetRun);
    return target
      ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, {
          ...target,
          ...(contextId ? { contextId } : {}),
          ...(role ? { role } : {}),
        })
      : undefined;
  }, [targetRun?.id, targetRun?.slotId, targetRun?.reviewWorkspace?.workspaceId, contextId, role]);
  const progressObservation = useResourceQuery(progressQuery);
  const taskProgress = progressObservation.data?.structured ?? null;
  const taskProgressError = progressObservation.error
    ? `Task progress unavailable: ${progressObservation.error.message}`
    : null;
  const terminalTargetParams = slotId || runId ? terminalContext.target : null;
  const contextRef = useRef(terminalContext);
  contextRef.current = terminalContext;

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
  const subscriptionStarts = useRef(0);
  const inputCommands = useRef(0);
  const commandRequests = useRef(new Map<string, object>());
  const requireTerminalTarget = useCallback(() => {
    const context = contextRef.current;
    if (context.scopeKey !== terminalContext.scopeKey)
      throw new Error('The terminal target changed. Review it before acting.');
    context.requireRun();
    const target = terminalTargetParamsRef.current;
    if (!target || JSON.stringify(target) !== JSON.stringify(context.target))
      throw new Error('Wait for the selected terminal target before acting.');
    return { target, ...context.capture() };
  }, [terminalContext.scopeKey]);
  const beginTerminalCommand = useCallback(
    (kind: string) => {
      const captured = requireTerminalTarget();
      if (commandRequests.current.has(kind)) return;
      const request = {};
      commandRequests.current.set(kind, request);
      return {
        ...captured,
        finish: (cleanup: () => void) => {
          if (commandRequests.current.get(kind) !== request || !captured.ownsView()) return;
          commandRequests.current.delete(kind);
          cleanup();
        },
      };
    },
    [requireTerminalTarget],
  );
  useLayoutEffect(() => {
    commandRequests.current.clear();
    setIsSending(false);
    setIsSendingControl(false);
    setActiveControlKey(null);
    setActiveTmuxAction(null);
    setControlError(null);
    setTmuxError(null);
    setTmuxWindows([]);
    setSnapshotRole(null);
    setSnapshotContextId(null);
    setSnapshotError(null);
    setStreamMode('connecting');
    setIsFormattingVoice(false);
    setVoiceWarning(null);
    setVoiceTargetSuggestion(null);
    terminalTailTextRef.current = '';
    setLines([]);
    setLastUpdated(null);
    terminalViewRef.current?.reset('');
  }, [terminalContext.scopeKey]);

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
    native.target?.label ??
    (streamMode === 'connecting' ? 'Connecting' : streamMode === 'ended' ? 'Ended' : 'Live');
  const terminalLabel = slotId || targetRun?.reviewWorkspace?.machine || 'Run terminal';
  const terminalInputDisabledReason = !terminalContext.ready
    ? 'Wait for current terminal run data'
    : streamMode === 'ended'
      ? 'Read-only · terminal ended'
      : null;

  useTerminalProof({
    focused,
    run: targetRun,
    recipes: terminalContext.recipes,
    terminalReady: terminalContext.ready,
    terminalTarget: terminalContext.target ?? undefined,
    terminalInputDisabledReason,
    terminalStream: streamMode,
    terminalControlBusy: isSendingControl,
    terminalControlError: controlError,
    terminalSnapshotError: snapshotError,
    readTerminalText: () => terminalViewRef.current?.inspect?.() ?? Promise.resolve(''),
    terminalInputCommands: inputCommands.current,
    terminalSubscriptionStarts: subscriptionStarts.current,
  });
  const sendTerminalInput = useTerminalInput(
    terminalTargetParams,
    terminalTargetParamsRef,
    terminalInputDisabledReason,
  );

  const loadInitialSnapshot = useCallback(async () => {
    const target = terminalTargetParamsRef.current;
    if (!client || !target) {
      setSnapshotError('Not connected to gateway.');
      return;
    }

    const captured = terminalContext.capture();
    try {
      terminalContext.requireRun();
      const result = await client.request<TerminalSnapshotResult>('terminal.snapshot', {
        ...target,
        lines: lineCountRef.current,
      });
      if (!captured.current()) return;
      const snapshotText = result.lines.join('\n');
      replaceTerminalTail(snapshotText, result.timestamp);
      terminalViewRef.current?.reset(snapshotText.replace(/\n/g, '\r\n'));
      setSnapshotRole(result.role ?? null);
      setSnapshotContextId(result.contextId ?? null);
      setSnapshotError(null);
    } catch (error) {
      if (!captured.current()) return;
      setSnapshotError(`Snapshot failed: ${getErrorMessage(error)}`);
    }
  }, [client, replaceTerminalTail, terminalContext.scopeKey]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      if (terminalInputDisabledReason || !client) return;
      try {
        const captured = requireTerminalTarget();
        sendTerminalInput(data).catch((error: unknown) => {
          // Navigation/disconnect deliberately discards unsent input.
          if (!(error instanceof TerminalInputCancelledError) && captured.current())
            setSnapshotError(`Terminal input failed: ${getErrorMessage(error)}`);
        });
      } catch (error) {
        setSnapshotError(getErrorMessage(error));
      }
    },
    [client, requireTerminalTarget, sendTerminalInput, terminalInputDisabledReason],
  );

  const handleTerminalResize = useCallback(
    (size: TerminalSize) => {
      terminalSizeRef.current = size;
      if (!client || !contextRef.current.ready) return;
      try {
        const captured = requireTerminalTarget();
        client
          .request('terminal.resize', { ...captured.target, ...size }, 10_000)
          .catch((error: Error) => {
            if (captured.current()) setSnapshotError(`Terminal resize failed: ${error.message}`);
          });
      } catch (error) {
        setSnapshotError(getErrorMessage(error));
      }
    },
    [client, requireTerminalTarget],
  );

  useEffect(() => {
    if (!focused || !client || (!slotId && !runId)) return;
    if (!terminalContext.streamReady || connectionStatus !== 'connected') {
      setStreamMode('connecting');
      setSnapshotError('Waiting for gateway connection.');
      terminalViewRef.current?.setStatus('Waiting for gateway connection.');
      return;
    }
    if (native.target || native.unavailable || (contextId && !targetRun)) return;
    let disposed = false;
    const captured = terminalContext.capture();
    let target =
      terminalTargetParamsRef.current ??
      buildCompanionTerminalTarget({ slotId, runId, contextId, role, bareSession: false });
    setStreamMode('connecting');
    setSnapshotError(null);
    terminalViewRef.current?.setStatus('Connecting terminal…');

    const matchesTarget = (payload: { slotId?: string; runId?: string }) => {
      return !disposed && captured.current() && matchesCompanionTerminalTarget(payload, target);
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
      if (disposed || !captured.current()) return;
      try {
        terminalContext.requireRun();
      } catch (error) {
        setSnapshotError(getErrorMessage(error));
        return;
      }
      target = terminalTargetParams!;

      terminalTargetParamsRef.current = target;

      try {
        subscriptionStarts.current++;
        await client.request('terminal.subscribe', {
          ...target,
          interactive: true,
          cols: terminalSizeRef.current.cols,
          rows: terminalSizeRef.current.rows,
        });
        if (!disposed && captured.current()) {
          setSnapshotError(null);
          terminalViewRef.current?.setStatus('');
        }
      } catch (error) {
        if (!disposed && captured.current()) {
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
      if (!captured.connectionCurrent()) return;
      client.request('terminal.unsubscribe', target).catch((error: Error) => {
        // Unsubscribe can race with slot teardown; after unmount there is no visible terminal
        // state to update, and the gateway also releases handlers when the socket closes.
        console.warn(`[terminal] unsubscribe failed for ${slotId}: ${error.message}`);
      });
    };
  }, [
    appendTerminalTail,
    client,
    connectionStatus,
    focused,
    terminalContext.streamReady,
    terminalContext.scopeKey,
    terminalTargetParams,
    runId,
    slotId,
    contextId,
    role,
    native.contextId,
    Boolean(native.target),
    native.unavailable,
    Boolean(targetRun),
  ]);

  useEffect(() => {
    if (
      !focused ||
      connectionStatus !== 'connected' ||
      !terminalContext.streamReady ||
      native.target ||
      native.unavailable ||
      (contextId && !targetRun)
    )
      return;
    loadInitialSnapshot();
  }, [
    focused,
    connectionStatus,
    terminalContext.streamReady,
    terminalContext.scopeKey,
    lineCount,
    loadInitialSnapshot,
    Boolean(native.target),
    native.unavailable,
    contextId,
    Boolean(targetRun),
  ]);

  const resolveTerminalTargetRun = useCallback(async (): Promise<Run | null> => {
    return contextRef.current.requireRun();
  }, []);

  const sendControlKey = useCallback(
    async (control: TerminalControlKey) => {
      if (!client || isSendingControl || terminalInputDisabledReason) return;
      let command: ReturnType<typeof beginTerminalCommand>;
      try {
        command = beginTerminalCommand('control');
        if (!command) return;
        setIsSendingControl(true);
        setActiveControlKey(control.label);
        setControlError(null);
        inputCommands.current++;
        await sendTerminalInput(control.data);
        if (!command.current()) return;
        await Haptics.impactAsync(
          control.danger ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
        );
      } catch (error) {
        if (!(error instanceof TerminalInputCancelledError) && (!command || command.current()))
          setControlError(`Control failed: ${getErrorMessage(error)}`);
      } finally {
        command?.finish(() => {
          setIsSendingControl(false);
          setActiveControlKey(null);
        });
      }
    },
    [
      beginTerminalCommand,
      client,
      isSendingControl,
      sendTerminalInput,
      terminalInputDisabledReason,
    ],
  );

  const refreshTmuxWindows = useCallback(async () => {
    if (!client || !slotId || connectionStatus !== 'connected' || !contextRef.current.ready) {
      setTmuxWindows([]);
      return;
    }
    const captured = terminalContext.capture();
    try {
      terminalContext.requireRun();
      const result = await listSlotTmuxWindows(slotId, (method, params) =>
        client.request<TmuxListResult>(method, params),
      );
      if (!captured.current()) return;

      setTmuxWindows(result.windows);
      setTmuxError(null);
    } catch (error) {
      if (!captured.current()) return;
      setTmuxWindows([]);
      setTmuxError(`Tmux state failed: ${getErrorMessage(error)}`);
    }
  }, [client, connectionStatus, terminalContext.scopeKey]);

  const runTmuxAction = useCallback(
    async (label: string, method: MobileTmuxActionMethod, params: Record<string, unknown> = {}) => {
      if (
        !client ||
        !terminalTargetParamsRef.current?.slotId ||
        activeTmuxAction ||
        !contextRef.current.ready
      )
        return;
      let command: ReturnType<typeof beginTerminalCommand>;
      try {
        command = beginTerminalCommand('tmux');
        if (!command) return;
        setActiveTmuxAction(label);
        setTmuxError(null);
        await client.request(method, {
          ...(method === Methods.TMUX_SELECT_WINDOW
            ? slotTmuxWindowTarget(slotId)
            : command.target),
          ...params,
        });
        if (!command.current()) return;
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (!command.current()) return;
        await refreshTmuxWindows();
      } catch (error) {
        if (!command || command.current())
          setTmuxError(`${label} failed: ${getErrorMessage(error)}`);
      } finally {
        command?.finish(() => setActiveTmuxAction(null));
      }
    },
    [activeTmuxAction, beginTerminalCommand, client, refreshTmuxWindows, slotId],
  );

  useEffect(() => {
    if (
      connectionStatus !== 'connected' ||
      !terminalContext.streamReady ||
      (!showTerminalControls && !showTerminalOptions && !native.tabs.length)
    )
      return;
    void refreshTmuxWindows();
  }, [
    connectionStatus,
    refreshTmuxWindows,
    terminalContext.streamReady,
    showTerminalControls,
    showTerminalOptions,
    terminalTargetParams,
    native.tabs.length,
  ]);

  const sendTerminalText = useCallback(
    async (text: string, setError: (message: string | null) => void): Promise<boolean> => {
      const trimmedText = text.trim();
      if (!client || !trimmedText || isSending || terminalInputDisabledReason) return false;
      let command: ReturnType<typeof beginTerminalCommand>;
      try {
        command = beginTerminalCommand('send');
        if (!command) return false;
        const message =
          pendingOperatorMessage.current?.text === trimmedText
            ? pendingOperatorMessage.current
            : operatorMessageInput(trimmedText);
        pendingOperatorMessage.current = message;
        setIsSending(true);
        inputCommands.current++;
        const request = terminalTextRequest(command.target, message);
        await client.request(request.method, request.params);
        if (!command.current()) return false;
        if (pendingOperatorMessage.current === message) pendingOperatorMessage.current = null;
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        if (!command.current()) return false;
        setError(null);
        return true;
      } catch (error) {
        if (!command || command.current()) setError(`Send failed: ${getErrorMessage(error)}`);
        return false;
      } finally {
        command?.finish(() => setIsSending(false));
      }
    },
    [beginTerminalCommand, client, isSending, terminalInputDisabledReason],
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
  const voiceGatewayReady =
    terminalContext.ready && connectionStatus === 'connected' && Boolean(client);
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
  const showInputBar =
    !native.target && !native.unavailable && (showTerminalControls || Boolean(controlError));
  const showVoiceComposer =
    !native.target &&
    !native.unavailable &&
    (voiceComposerOpen ||
      voiceStatus !== 'idle' ||
      hasVoiceEditableInstruction ||
      isPreparingVoiceRecorder ||
      isFormattingVoice);
  const showVoiceProgressText =
    Boolean(voiceMessage) &&
    (isPreparingVoiceRecorder ||
      voiceStatus === 'transcribing' ||
      isFormattingVoice ||
      isDownloadingVoiceModel);
  const onVoiceComposerLayout = useQuickActionComposerInset(
    !native.target && !terminalInputDisabledReason && showVoiceComposer,
  );
  const voiceWidgetWidth = Math.max(1, voicePanelWidth - spacing.md * 2);

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
      let command: ReturnType<typeof beginTerminalCommand>;
      try {
        command = beginTerminalCommand('format');
      } catch (error) {
        setVoiceWarning(getErrorMessage(error));
        return false;
      }
      if (!command) return false;
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
        if (!command.current()) return false;
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
        if (!command.current()) return false;
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
        if (!command.current()) return false;
        const prefix = automatic ? 'Auto-clean failed' : 'Clean up failed';
        setVoiceWarning(`${prefix} via copilot.formatInstruction: ${getErrorMessage(error)}`);
        return false;
      } finally {
        command.finish(() => setIsFormattingVoice(false));
      }
    },
    [
      beginTerminalCommand,
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
      resetVoiceCopilotAfterSend('Sent. Tap mic to dictate another instruction.');
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
      pathname: '/workspace/slot/[slotId]/terminal',
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

  useQuickActionVoiceTarget(
    JSON.stringify(['slot', slotId, targetRun?.id ?? null, contextId ?? null]),
    handleFloatingVoicePress,
    !voiceRecorderBusy && !voiceRuntimePending,
    !native.target && !native.unavailable && !terminalInputDisabledReason,
  );

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
      testID="companion-screen-slot-terminal"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
      style={[
        baseStyles.container,
        terminalFullscreen && styles.fullscreenContainer,
        { paddingTop: insideSlotWorkspaceTabs ? 0 : insets.top },
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
                {terminalLabel}
              </Text>
              <Text style={styles.fullscreenMeta} numberOfLines={1}>
                {streamLabel} · {lines.length} lines
              </Text>
            </View>
            <SlotTerminalFullscreenViewControls
              controls={orientationControls}
              keysActive={showTerminalControls}
              mode={terminalViewMode}
              onModeChange={setTerminalViewMode}
              onExit={toggleTerminalFullscreen}
              onToggleKeys={() => setShowTerminalControls((current) => !current)}
            />
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
      {!terminalFullscreen && !native.target && !native.unavailable && (
        <ScrollView
          style={[styles.header, { maxHeight: terminalHeaderMaxHeight }]}
          contentContainerStyle={styles.headerContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator={showTerminalOptions}
        >
          <View style={styles.terminalCompactHeader}>
            {!insideSlotWorkspaceTabs && (
              <Pressable style={styles.backButton} onPress={goBackOrHome}>
                <Text style={styles.backButtonText}>‹</Text>
              </Pressable>
            )}
            <View style={styles.terminalIdentity}>
              <Text style={styles.terminalTarget} numberOfLines={1}>
                {terminalLabel}
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
            <SlotTerminalCompactViewControls
              keysActive={showTerminalControls}
              mode={terminalViewMode}
              onExpand={toggleTerminalFullscreen}
              onModeChange={setTerminalViewMode}
              onToggleKeys={() => setShowTerminalControls((current) => !current)}
            />
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
            slotId={slotId}
            run={targetRun}
            fallbackRunId={runId}
            streamLabel={streamLabel}
            liveBadgeColor={liveBadgeColor}
            targetWarning={targetWarning}
            terminalInputDisabled={Boolean(terminalInputDisabledReason)}
            voiceRecorderBusy={voiceRecorderBusy}
            onOpenTmux={() => setShowTerminalControls(true)}
            onOpenContext={() => setShowTerminalOptions(true)}
            onOpenVoice={handleFloatingVoicePress}
            onOpenKeyboard={() => {
              setAllowTerminalTouchKeyboard(true);
              setShowTerminalControls(true);
            }}
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
              <TaskProgressPanel summary={fallbackTaskProgress} error={taskProgressError} compact />
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
              {terminalContext.run.error || terminalContext.slot.error ? (
                <Pressable style={styles.retryButton} onPress={() => void terminalContext.retry()}>
                  <Text style={styles.warningRetryText}>Retry</Text>
                </Pressable>
              ) : null}
            </View>
          )}
          {targetRecipeAvailabilityError && (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>{targetRecipeAvailabilityError}</Text>
              <Pressable accessibilityRole="button" onPress={() => void terminalContext.retry()}>
                <Text style={styles.warningRetryText}>Retry</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      )}

      <ResourceReadStatus observation={terminalContext.run} label="terminal run" />
      {progressQuery ? (
        <ResourceReadStatus observation={progressObservation} label="task progress" />
      ) : null}
      {progressObservation.error && progressQuery ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry task progress"
          onPress={() => void getResourceCache()?.retry(progressQuery)}
        >
          <Text style={styles.warningRetryText}>Retry</Text>
        </Pressable>
      ) : null}
      <SlotTerminalSessionPane
        key={terminalContext.scopeKey}
        native={native}
        windows={tmuxWindows}
        disabled={
          !terminalContext.ready || connectionStatus !== 'connected' || Boolean(activeTmuxAction)
        }
        onTmuxAction={runTmuxAction}
        terminal={{
          ref: terminalViewRef,
          allowTouchKeyboard: allowTerminalTouchKeyboard,
          initialText: lines.join('\r\n'),
          mode: terminalViewMode,
          onInput: handleTerminalInput,
          onResize: handleTerminalResize,
          rawHistoryText: terminalTailTextRef.current,
          readOnlyReason: terminalInputDisabledReason,
        }}
      />

      {!native.target && !terminalInputDisabledReason && showVoiceComposer && (
        <View
          style={[
            styles.voicePanel,
            !showInputBar && { paddingBottom: spacing.sm + insets.bottom },
          ]}
          onLayout={(event) => {
            setVoicePanelWidth(event.nativeEvent.layout.width);
            onVoiceComposerLayout(event);
          }}
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

      {showInputBar && (
        <View style={[styles.composer, { paddingBottom: spacing.sm + insets.bottom }]}>
          {showTerminalControls && (
            <View style={styles.controlPanel}>
              <TerminalControlKeyBar
                activeLabel={activeControlKey}
                disabled={isSendingControl || Boolean(terminalInputDisabledReason)}
                touchKeyboardEnabled={allowTerminalTouchKeyboard}
                onPress={(control) => void sendControlKey(control)}
                runnerPane={slotTerminalRunnerPane(slot, tmuxWindows)}
                onToggleTouchKeyboard={() =>
                  setAllowTerminalTouchKeyboard(!allowTerminalTouchKeyboard)
                }
              />
              {slotId ? (
                <TmuxControlPanel
                  windows={tmuxWindows}
                  activeAction={activeTmuxAction}
                  disabled={Boolean(terminalInputDisabledReason) || Boolean(activeTmuxAction)}
                  onRefresh={refreshTmuxWindows}
                  onAction={runTmuxAction}
                />
              ) : null}
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
