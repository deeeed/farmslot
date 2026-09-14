import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { NativeTimelineEntry } from '../../../lib/native-conversation';
import { nativeStyles as styles } from '../styles/native-conversation.styles';

export function NativeTimelineCard({ entry }: { entry: NativeTimelineEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={[styles.card, entry.kind === 'user' && styles.user]}>
      <Text style={styles.muted}>
        {entry.kind === 'user'
          ? 'You'
          : entry.kind === 'assistant'
            ? 'Assistant'
            : entry.kind === 'tool'
              ? 'Tool'
              : 'Status'}
      </Text>
      {entry.kind === 'tool' ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
          >
            <Text style={styles.buttonText}>
              {entry.text} ·{' '}
              {entry.event.tool?.status ??
                (entry.event.type === 'tool.completed' ? 'completed' : 'running')}{' '}
              · {expanded ? 'Hide' : 'Details'}
            </Text>
          </Pressable>
          {expanded ? (
            <ScrollView nestedScrollEnabled style={styles.detail}>
              <Text selectable style={styles.code}>
                {JSON.stringify(entry.event.tool, null, 2)}
              </Text>
            </ScrollView>
          ) : null}
        </>
      ) : (
        <Text selectable style={entry.kind === 'status' ? styles.muted : styles.text}>
          {entry.text}
        </Text>
      )}
    </View>
  );
}
