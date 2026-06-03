import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  Events,
  Methods,
  type RecipeCancelResult,
  type RecipeCommandResult,
  type RecipeRerunParams,
  type ScriptActionResult,
} from '@farmslot/protocol';

import type { GatewayClient } from '../lib/gateway-client';
import { colors, fonts, radii, spacing } from '../lib/theme';

interface RecipeRunControlsProps {
  client: GatewayClient | null;
  runId: string;
  slotId: string | null | undefined;
  recipeRunId?: string | null;
  onComplete?: (requestId: string) => void;
}

interface RecipeOutputState {
  requestId: string;
  running: boolean;
  lines: string[];
  exitCode?: number;
  error?: string;
  artifactRoot?: string;
}

type EarlyRecipeEvent =
  | { kind: 'output'; requestId: string; data: string }
  | {
      kind: 'complete';
      requestId: string;
      exitCode?: number;
      error?: string;
      artifactRoot?: string;
    };

const PLAYBACK_OPTIONS = [
  { label: 'Normal', value: 0 },
  { label: '2s', value: 2000 },
  { label: '5s', value: 5000 },
] as const;
const RECIPE_OUTPUT_MAX_LINES = 500;

export function RecipeRunControls({
  client,
  runId,
  slotId,
  recipeRunId,
  onComplete,
}: RecipeRunControlsProps) {
  const [playbackSlowMs, setPlaybackSlowMs] = useState(2000);
  const [output, setOutput] = useState<RecipeOutputState | null>(null);
  const [commandPreview, setCommandPreview] = useState('');
  const [error, setError] = useState('');
  const outputRef = useRef<RecipeOutputState | null>(null);
  const runningGuardRef = useRef(false);
  const unsubscribersRef = useRef<Array<() => void>>([]);
  const earlyEventsRef = useRef<EarlyRecipeEvent[]>([]);

  const canRun = Boolean(client && runId && slotId && !output?.running);
  const canCancel = Boolean(client && slotId && output?.running && output.requestId);
  const canCommand = Boolean(client && runId && slotId && !output?.running);
  const params = useMemo(
    () => recipeRequestParams(runId, slotId ?? '', recipeRunId, playbackSlowMs),
    [playbackSlowMs, recipeRunId, runId, slotId],
  );

  useEffect(() => {
    outputRef.current = output;
  }, [output]);

  useEffect(
    () => () => {
      runningGuardRef.current = false;
      unsubscribersRef.current.forEach((unsubscribe) => unsubscribe());
      unsubscribersRef.current = [];
    },
    [],
  );

  const appendLines = useCallback((lines: string[]) => {
    setOutput((current) =>
      current
        ? {
            ...current,
            lines: appendLimitedLines(current.lines, lines),
          }
        : current,
    );
  }, []);

  const clearSubscriptions = useCallback(() => {
    unsubscribersRef.current.forEach((unsubscribe) => unsubscribe());
    unsubscribersRef.current = [];
  }, []);

  const subscribeToOutput = useCallback(
    (requestIdRef: { current: string }) => {
      if (!client) return;
      clearSubscriptions();
      const unsubscribeOutput = client.subscribe(Events.SCRIPT_OUTPUT, (payload) => {
        const data = payload as { requestId?: string; data?: string };
        if (!data.requestId) return;
        if (!requestIdRef.current) {
          earlyEventsRef.current.push({
            kind: 'output',
            requestId: data.requestId,
            data: data.data ?? '',
          });
          return;
        }
        if (data.requestId !== requestIdRef.current) return;
        appendLines(outputLinesFromChunk(data.data ?? ''));
      });
      const unsubscribeComplete = client.subscribe(Events.SCRIPT_COMPLETE, (payload) => {
        const data = payload as {
          requestId?: string;
          exitCode?: number;
          error?: string;
          artifactRoot?: string;
        };
        if (!data.requestId) return;
        if (!requestIdRef.current) {
          earlyEventsRef.current.push({
            kind: 'complete',
            requestId: data.requestId,
            exitCode: data.exitCode,
            error: data.error,
            artifactRoot: data.artifactRoot,
          });
          return;
        }
        if (data.requestId !== requestIdRef.current) return;
        setOutput((current) =>
          current
            ? {
                ...current,
                running: false,
                exitCode: data.exitCode,
                error: data.error,
                artifactRoot: data.artifactRoot,
                lines: appendLimitedLines(current.lines, [`Complete: exit ${data.exitCode ?? 0}`]),
              }
            : current,
        );
        runningGuardRef.current = false;
        clearSubscriptions();
        onComplete?.(data.requestId);
      });
      unsubscribersRef.current = [unsubscribeOutput, unsubscribeComplete];
    },
    [appendLines, clearSubscriptions, client, onComplete],
  );

  const runRecipe = useCallback(async () => {
    if (!client || !params || runningGuardRef.current || outputRef.current?.running) return;
    runningGuardRef.current = true;
    setError('');
    setCommandPreview('');
    earlyEventsRef.current = [];
    setOutput({
      requestId: '',
      running: true,
      lines: ['Starting recipe...'],
    });
    const requestIdRef = { current: '' };
    subscribeToOutput(requestIdRef);
    try {
      const result = await client.request<ScriptActionResult>(Methods.RECIPE_RERUN, params, 30_000);
      requestIdRef.current = result.requestId;
      const earlyEvents = earlyEventsRef.current.filter(
        (event) => event.requestId === result.requestId,
      );
      const earlyOutputLines = earlyEvents
        .filter(
          (event): event is Extract<EarlyRecipeEvent, { kind: 'output' }> =>
            event.kind === 'output',
        )
        .flatMap((event) => outputLinesFromChunk(event.data));
      const earlyComplete = earlyEvents.find(
        (event): event is Extract<EarlyRecipeEvent, { kind: 'complete' }> =>
          event.kind === 'complete',
      );
      earlyEventsRef.current = [];
      setOutput((current) => ({
        requestId: result.requestId,
        running: !earlyComplete,
        lines: appendLimitedLines(current?.lines ?? ['Starting recipe...'], [
          ...earlyOutputLines,
          ...(earlyComplete ? [`Complete: exit ${earlyComplete.exitCode ?? 0}`] : []),
        ]),
        ...(earlyComplete
          ? {
              exitCode: earlyComplete.exitCode,
              error: earlyComplete.error,
              artifactRoot: earlyComplete.artifactRoot,
            }
          : {}),
      }));
      if (earlyComplete) {
        runningGuardRef.current = false;
        clearSubscriptions();
        onComplete?.(result.requestId);
      }
    } catch (err) {
      runningGuardRef.current = false;
      clearSubscriptions();
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to start recipe: ${message}`);
      setOutput({
        requestId: '',
        running: false,
        lines: [`Error: ${message}`],
        exitCode: 1,
        error: message,
      });
    }
  }, [clearSubscriptions, client, onComplete, params, subscribeToOutput]);

  const cancelRecipe = useCallback(async () => {
    if (!client || !slotId || !outputRef.current?.running || !outputRef.current.requestId) return;
    try {
      const result = await client.request<RecipeCancelResult>(Methods.RECIPE_CANCEL, {
        slotId,
        requestId: outputRef.current.requestId,
      });
      if (!result.cancelled) {
        const reason = result.reason ?? 'unknown reason';
        setError(`Cancel not accepted: ${reason}`);
        appendLines([`Cancel not accepted: ${reason}`]);
      }
    } catch (err) {
      appendLines([`Cancel failed: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }, [appendLines, client, slotId]);

  const showCommand = useCallback(async () => {
    if (!client || !params) return;
    setError('');
    try {
      const result = await client.request<RecipeCommandResult>(Methods.RECIPE_COMMAND, params);
      setCommandPreview(result.command);
    } catch (err) {
      setError(`Failed to build command: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, params]);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Live replay</Text>
          <Text style={styles.description}>
            Run this recipe on the warm slot, slow playback for review, then inspect the new
            artifacts from the automatically refreshed recipe evidence selector.
          </Text>
        </View>
      </View>

      <View style={styles.playbackRow}>
        <Text style={styles.playbackLabel}>Playback</Text>
        {PLAYBACK_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            style={[
              styles.playbackChip,
              playbackSlowMs === option.value && styles.activeChip,
              output?.running && styles.disabledButton,
            ]}
            disabled={output?.running}
            accessibilityLabel={`Set recipe playback to ${option.label}`}
            onPress={() => setPlaybackSlowMs(option.value)}
          >
            <Text
              style={[
                styles.playbackChipText,
                playbackSlowMs === option.value && styles.activeChipText,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.actionRow}>
        {output?.running ? (
          <Pressable
            style={[styles.button, styles.cancelButton, !canCancel && styles.disabledButton]}
            disabled={!canCancel}
            accessibilityLabel="Cancel live recipe replay"
            onPress={cancelRecipe}
          >
            <Text style={[styles.buttonText, styles.cancelText]}>Cancel</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.button, styles.primaryButton, !canRun && styles.disabledButton]}
            disabled={!canRun}
            accessibilityLabel="Run live recipe"
            onPress={runRecipe}
          >
            <Text style={styles.primaryButtonText}>Run live recipe</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.button, !canCommand && styles.disabledButton]}
          disabled={!canCommand}
          accessibilityLabel="Show recipe command"
          onPress={showCommand}
        >
          <Text style={styles.buttonText}>{output?.running ? 'Running…' : 'Show command'}</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {commandPreview ? (
        <ScrollView horizontal style={styles.commandBox}>
          <Text style={styles.commandText}>{commandPreview}</Text>
        </ScrollView>
      ) : null}

      {output ? (
        <ScrollView style={styles.outputBox} nestedScrollEnabled>
          {output.lines.map((line, index) => (
            <Text key={`${index}:${line}`} style={styles.outputLine}>
              {line}
            </Text>
          ))}
          {output.error ? <Text style={styles.errorText}>{output.error}</Text> : null}
          {output.artifactRoot ? (
            <Text style={styles.artifactRoot}>Artifacts: {output.artifactRoot}</Text>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

function recipeRequestParams(
  runId: string,
  slotId: string,
  recipeRunId: string | null | undefined,
  playbackSlowMs: number,
): RecipeRerunParams | null {
  if (!runId || !slotId) return null;
  const params: RecipeRerunParams = { runId, slotId };
  if (recipeRunId) params.recipeRunId = recipeRunId;
  if (playbackSlowMs > 0) params.playbackSlowMs = playbackSlowMs;
  return params;
}

function outputLinesFromChunk(chunk: string): string[] {
  return chunk ? chunk.split('\n') : [];
}

function appendLimitedLines(lines: string[], additions: string[]): string[] {
  const next = [...lines, ...additions];
  return next.length > RECIPE_OUTPUT_MAX_LINES ? next.slice(-RECIPE_OUTPUT_MAX_LINES) : next;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  headerCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  description: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
  },
  playbackRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  playbackLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  playbackChip: {
    borderColor: colors.bgInput,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  activeChip: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  playbackChipText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  activeChipText: {
    color: colors.accent,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  button: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.accent,
  },
  cancelButton: {
    backgroundColor: colors.statusFail + '22',
  },
  disabledButton: {
    opacity: 0.45,
  },
  buttonText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  cancelText: {
    color: colors.statusFail,
  },
  commandBox: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  commandText: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
  },
  outputBox: {
    backgroundColor: '#050505',
    borderRadius: radii.md,
    maxHeight: 180,
    padding: spacing.md,
  },
  outputLine: {
    color: colors.textSecondary,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeXs,
  },
  artifactRoot: {
    color: colors.statusOk,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
});
