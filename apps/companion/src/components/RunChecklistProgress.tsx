import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import type { Run, TaskProgressStructured } from '@farmslot/protocol';
import { runChecklistProgressView } from '@farmslot/review-dispatch';
import { publicationGateColors } from '@farmslot/theme';

import { fonts } from '../lib/theme';

/** One fixed-height strip, reused below either size of run pipeline. */
export function RunChecklistProgress({
  run,
  progress,
  error,
}: {
  run: Run;
  progress?: TaskProgressStructured | null;
  error?: string;
}) {
  const view = runChecklistProgressView(run, progress);
  const palette = publicationGateColors[useColorScheme() === 'light' ? 'light' : 'dark'];
  return (
    <View style={styles.container} testID="run-checklist-progress">
      {view ? (
        <View
          accessibilityLabel={view.accessibleLabel}
          style={{ backgroundColor: palette.background }}
        >
          <View style={styles.label}>
            <Text style={[styles.counts, { color: palette.secondary }]}>{view.counts}</Text>
            <Text style={[styles.item, { color: palette.secondary }]} numberOfLines={1}>
              {view.label}
            </Text>
          </View>
          <View
            style={[styles.track, { backgroundColor: palette.border }]}
            accessibilityRole="progressbar"
            accessibilityLabel={view.accessibleLabel}
            accessibilityValue={{ min: 0, max: view.total, now: view.completed }}
          >
            <View
              style={[styles.fill, { width: `${view.percent}%`, backgroundColor: palette.accent }]}
            />
          </View>
        </View>
      ) : error ? (
        <Text style={[styles.item, { color: palette.secondary }]} accessibilityLabel={error}>
          Checklist unavailable
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { height: 28, width: '100%', minWidth: 0 },
  label: { flexDirection: 'row', gap: 6, alignItems: 'center', height: 18 },
  counts: { fontSize: fonts.sizeXs, fontVariant: ['tabular-nums'] },
  item: { fontSize: fonts.sizeXs, flex: 1 },
  track: { height: 2, borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%' },
});
