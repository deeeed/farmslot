import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text } from 'react-native';

import { TerminalOrientationButton } from '../../../components/TerminalOrientationButton';
import type { TerminalOrientationControls } from '../../../lib/terminal-orientation';
import { colors } from '../../../lib/theme';
import { slotTerminalStyles as styles } from '../styles/slot-terminal.styles';

import { TerminalKeysModeControls, type TerminalViewMode } from './terminal-history-viewer';

export function SlotTerminalFullscreenViewControls({
  controls,
  keysActive,
  mode,
  onExit,
  onModeChange,
  onToggleKeys,
}: {
  controls: TerminalOrientationControls;
  keysActive: boolean;
  mode: TerminalViewMode;
  onExit: () => void;
  onModeChange: (mode: TerminalViewMode) => void;
  onToggleKeys: () => void;
}) {
  return (
    <>
      <TerminalKeysModeControls
        active={keysActive}
        buttonActiveStyle={styles.tailToggleActive}
        buttonStyle={styles.fullscreenPill}
        mode={mode}
        onModeChange={onModeChange}
        onToggleKeys={onToggleKeys}
        textActiveStyle={styles.tailToggleTextActive}
        textStyle={styles.fullscreenPillText}
      />
      <TerminalOrientationButton controls={controls} />
      <Pressable style={styles.fullscreenPill} onPress={onExit}>
        <Text style={styles.fullscreenPillText}>Exit</Text>
      </Pressable>
    </>
  );
}

export function SlotTerminalCompactViewControls({
  keysActive,
  mode,
  onExpand,
  onModeChange,
  onToggleKeys,
}: {
  keysActive: boolean;
  mode: TerminalViewMode;
  onExpand: () => void;
  onModeChange: (mode: TerminalViewMode) => void;
  onToggleKeys: () => void;
}) {
  return (
    <>
      <TerminalKeysModeControls
        active={keysActive}
        buttonActiveStyle={styles.tailToggleActive}
        buttonStyle={styles.tailToggle}
        mode={mode}
        onModeChange={onModeChange}
        onToggleKeys={onToggleKeys}
        textActiveStyle={styles.tailToggleTextActive}
        textStyle={styles.tailToggleText}
      />
      <Pressable style={styles.tailToggle} onPress={onExpand}>
        <Ionicons name="expand-outline" size={16} color={colors.textSecondary} />
      </Pressable>
    </>
  );
}
