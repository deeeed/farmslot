import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { type TmuxWorkerSummary } from '@farmslot/protocol';

import { workerTerminalStyles as styles } from '../styles/worker-terminal.styles';

export function WorkerTmuxShortcutPanel({
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
export function buildWindowPickerEntries(
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
export function WindowPickerModal({
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
