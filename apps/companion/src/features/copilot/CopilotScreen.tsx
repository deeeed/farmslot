import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CopilotRuntimeSession } from '@farmslot/protocol';

import { baseStyles, colors, spacing } from '../../lib/theme';

import { copilotStyles as styles } from './styles/copilot.styles';
import type { useCopilotController } from './use-copilot-controller';

export function CopilotScreen({
  viewModel: vm,
  actions,
  draft,
  openTerminal,
  openNative,
}: ReturnType<typeof useCopilotController> & {
  draft?: string;
  openTerminal: (session: CopilotRuntimeSession) => void;
  openNative: () => void;
}) {
  const insets = useSafeAreaInsets();
  const available = vm.ready && vm.runtime?.status === 'running' && !!vm.runtime.terminalWorker;
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
      <Text style={styles.status}>
        {vm.runtime
          ? `Co-Pilot is ${vm.runtime.status}`
          : vm.loading
            ? 'Finding Co-Pilot…'
            : vm.connected
              ? 'Co-Pilot unavailable'
              : ''}
      </Text>
      <Text style={styles.hint}>
        Open the persistent Co-Pilot terminal or continue a native conversation. Start and configure
        sessions in Command Center.
      </Text>
      {draft ? (
        <View style={styles.pendingDraft}>
          <Text style={styles.pendingDraftLabel}>Pending instruction</Text>
          <Text style={styles.pendingDraftText}>{draft}</Text>
        </View>
      ) : null}
      {vm.saved ? (
        <Text style={styles.hint}>
          Saved{vm.observedAt ? ` · ${new Date(vm.observedAt).toLocaleString()}` : ''}
        </Text>
      ) : null}
      {vm.error ? <Text style={styles.error}>{vm.error}</Text> : null}
      {vm.runtime?.terminalReason ? (
        <Text style={styles.hint}>{vm.runtime.terminalReason}</Text>
      ) : null}
      <Pressable
        testID="companion-copilot-terminal"
        accessibilityRole="button"
        disabled={!available}
        style={[styles.button, !available && styles.buttonDisabled]}
        onPress={() => {
          if (vm.runtime) openTerminal(vm.runtime);
        }}
      >
        <Text style={styles.buttonText}>Open terminal</Text>
      </Pressable>
      <Pressable
        testID="companion-copilot-native"
        accessibilityRole="button"
        disabled={!vm.connected}
        style={[styles.button, !vm.connected && styles.buttonDisabled]}
        onPress={openNative}
      >
        <Text style={styles.buttonText}>Native conversations</Text>
      </Pressable>
      {vm.error ? (
        <Pressable
          testID="companion-copilot-retry"
          accessibilityRole="button"
          disabled={vm.loading || !vm.connected}
          style={[styles.button, (vm.loading || !vm.connected) && styles.buttonDisabled]}
          onPress={() => void actions.refresh()}
        >
          <Text style={styles.buttonText}>{vm.loading ? 'Checking…' : 'Retry status'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
