import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { evidenceReviewerTimeline, type EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import { colors, fonts } from '../lib/theme';

const PAGE_SIZE = 25;

export function RecordingTimeline({
  model,
  path,
  durationMs,
  maxHeight,
  selectedPage,
  onPage,
  onSeek,
}: {
  model: EvidenceReviewModel;
  path: string;
  durationMs: number;
  maxHeight: number;
  selectedPage: number;
  onPage: (page: number) => void;
  onSeek: (ms: number) => void;
}) {
  const open = selectedPage >= 0;
  const timeline = useMemo(
    () => (open ? evidenceReviewerTimeline(model, path, undefined, true) : undefined),
    [model, open, path],
  );
  const pages = Math.max(1, Math.ceil((timeline?.stepCount ?? 0) / PAGE_SIZE));
  const page = Math.min(Math.max(0, selectedPage), pages - 1);
  const rows = timeline?.page(page * PAGE_SIZE, PAGE_SIZE, model, durationMs || undefined);
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID="companion-recording-timeline"
        onPress={() => onPage(open ? -1 : 0)}
      >
        <Text style={styles.text}>
          Recording timeline{timeline?.stepCount ? ' · ' + timeline.stepCount + ' steps' : ''}
        </Text>
      </Pressable>
      {open ? (
        <>
          {rows?.length ? (
            <ScrollView nestedScrollEnabled style={{ maxHeight }} testID="companion-recording-rows">
              {rows.map(({ traceIndex, intent, ok, atMs, timeLabel }) => (
                <Pressable
                  key={traceIndex}
                  accessibilityRole="button"
                  disabled={atMs === null || !durationMs}
                  testID={'companion-recording-step-' + traceIndex}
                  onPress={() => {
                    if (atMs !== null) onSeek(atMs);
                  }}
                >
                  <Text style={[styles.text, !ok && styles.failed]}>
                    {timeLabel} · {intent}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.text}>Recording timeline unavailable</Text>
          )}
          {pages > 1 ? (
            <View style={styles.navigation}>
              <Pressable
                accessibilityRole="button"
                disabled={page === 0}
                onPress={() => onPage(page - 1)}
              >
                <Text style={styles.text}>Previous steps</Text>
              </Pressable>
              <Text style={styles.text}>
                {page + 1} of {pages}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={page + 1 >= pages}
                onPress={() => onPage(page + 1)}
              >
                <Text style={styles.text}>Next steps</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', paddingHorizontal: 8, gap: 6 },
  text: { color: colors.textPrimary, fontSize: fonts.sizeMd, paddingVertical: 4 },
  failed: { color: colors.statusFail },
  navigation: { flexDirection: 'row', justifyContent: 'space-between' },
});
