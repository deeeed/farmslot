import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { NativeTimelineEntry } from '@farmslot/protocol/client-cache';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

import { NativeTimelineCard } from './NativeTimelineCard';

/** A finished turn's tool calls behind one row, "Worked for 4m 12s · 6 tools". */
export function NativeWorkCard({
  label,
  entries,
  defaultExpanded,
  onDisclosure,
}: {
  label: string;
  entries: NativeTimelineEntry[];
  /** Open for a turn the reader watched run, so its tools do not fold away under them. */
  defaultExpanded: boolean;
  onDisclosure: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <View style={styles.card}>
      <Pressable
        testID="companion-native-work-fold"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={styles.messageToggle}
        onPress={() => {
          onDisclosure();
          setExpanded(!expanded);
        }}
      >
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
      {expanded
        ? entries.map((entry) => (
            <NativeTimelineCard key={entry.key} entry={entry} onDisclosure={onDisclosure} />
          ))
        : null}
    </View>
  );
}
