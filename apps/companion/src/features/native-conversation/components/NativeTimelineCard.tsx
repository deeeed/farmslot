import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  nativeEntryPreview,
  nativeMessageToggleLabel,
  type NativeTimelineEntry,
} from '@farmslot/protocol/client-cache';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

export function NativeTimelineCard({
  entry,
  onDisclosure,
  hidden = false,
}: {
  entry: NativeTimelineEntry;
  /** Called before the card opens or closes, so the conversation keeps the reader's place. */
  onDisclosure: () => void;
  /** Inside a closed fold: kept mounted, so its own state survives. */
  hidden?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => {
    onDisclosure();
    setExpanded(!expanded);
  };
  const preview = nativeEntryPreview(entry);
  return (
    <View style={[styles.card, entry.kind === 'user' && styles.user, hidden && styles.hidden]}>
      <Text style={styles.muted}>
        {entry.kind === 'user'
          ? 'You'
          : entry.kind === 'assistant'
            ? 'Assistant'
            : entry.kind === 'tool'
              ? 'Tool'
              : entry.kind === 'request'
                ? 'Request'
                : 'Status'}
      </Text>
      {entry.kind === 'tool' ? (
        <>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggle}>
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
        <>
          <Text selectable style={entry.kind === 'status' ? styles.muted : styles.text}>
            {preview && !expanded ? preview.text : entry.text}
          </Text>
          {preview ? (
            <Pressable
              testID="companion-native-message-toggle"
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              style={styles.messageToggle}
              onPress={toggle}
            >
              <Text style={styles.buttonText}>{nativeMessageToggleLabel(preview, expanded)}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
