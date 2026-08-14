import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type CopilotRuntimeSession,
  type CopilotRuntimeUpdatedPayload,
  type CopilotStatusResult,
  Events,
  Methods,
} from '@farmslot/protocol';

import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import { tmuxWorkerRouteParamsFromRef } from '../../lib/tmux-workers';
import { useConnectionStore } from '../../store/connection';

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default function CopilotScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { draft } = useLocalSearchParams<{ draft?: string | string[] }>();
  const client = useConnectionStore((state) => state.client);
  const connectionStatus = useConnectionStore((state) => state.status);
  const [runtime, setRuntime] = useState<CopilotRuntimeSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const openedTarget = useRef('');
  const pendingDraft = routeParam(draft).trim();

  const openTerminal = useCallback(
    (session: CopilotRuntimeSession) => {
      if (session.status !== 'running' || !session.terminalWorker) return;
      if (openedTarget.current === session.terminalWorker.target) return;
      openedTarget.current = session.terminalWorker.target;
      router.replace({
        pathname: '/terminal/worker',
        params: {
          ...tmuxWorkerRouteParamsFromRef(session.terminalWorker, 'Co-Pilot'),
          ...(pendingDraft ? { draft: pendingDraft } : {}),
        },
      });
    },
    [pendingDraft, router],
  );

  const refresh = useCallback(async () => {
    if (!client || connectionStatus !== 'connected') return;
    setLoading(true);
    setError('');
    try {
      const result = await client.request<CopilotStatusResult>(Methods.COPILOT_STATUS, {}, 10_000);
      setRuntime(result.session);
      openTerminal(result.session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client, connectionStatus, openTerminal]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!client) return;
    return client.subscribe(Events.COPILOT_RUNTIME_UPDATED, (payload) => {
      const { session } = payload as CopilotRuntimeUpdatedPayload;
      setRuntime(session);
      openTerminal(session);
    });
  }, [client, openTerminal]);

  const statusLabel =
    connectionStatus !== 'connected'
      ? 'Gateway disconnected'
      : runtime?.status === 'running' && !runtime.terminalWorker
        ? 'Gateway update required for terminal access'
        : runtime
          ? `Co-Pilot is ${runtime.status}`
          : loading
            ? 'Finding Co-Pilot…'
            : 'Co-Pilot unavailable';

  return (
    <View
      testID="companion-screen-copilot"
      style={[
        baseStyles.container,
        styles.container,
        { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl },
      ]}
    >
      <View style={styles.icon}>
        <Ionicons name="terminal-outline" size={28} color={colors.accent} />
      </View>
      <Text style={styles.title}>Operator Co-Pilot</Text>
      <Text style={styles.status}>{statusLabel}</Text>
      <Text style={styles.hint}>
        Co-Pilot uses one persistent gateway-owned tmux session. Start or configure it in Command
        Center when it is not running.
      </Text>
      {pendingDraft ? (
        <View style={styles.pendingDraft}>
          <Text style={styles.pendingDraftLabel}>Pending instruction</Text>
          <Text style={styles.pendingDraftText}>{pendingDraft}</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={[styles.button, loading && styles.buttonDisabled]}
        disabled={loading || connectionStatus !== 'connected'}
        onPress={() => void refresh()}
      >
        <Text style={styles.buttonText}>{loading ? 'Checking…' : 'Open terminal'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.bgBase, fontSize: fonts.sizeSm, fontWeight: '900' },
  container: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm, marginTop: spacing.md },
  hint: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    lineHeight: 20,
    marginTop: spacing.sm,
    maxWidth: 420,
    textAlign: 'center',
  },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.accent + '18',
    borderRadius: 999,
    height: 56,
    justifyContent: 'center',
    marginBottom: spacing.lg,
    width: 56,
  },
  pendingDraft: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.lg,
    padding: spacing.md,
    width: '100%',
  },
  pendingDraftLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  pendingDraftText: { color: colors.textSecondary, fontSize: fonts.sizeSm, lineHeight: 19 },
  status: { color: colors.textSecondary, fontSize: fonts.sizeMd, marginTop: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '900' },
});
