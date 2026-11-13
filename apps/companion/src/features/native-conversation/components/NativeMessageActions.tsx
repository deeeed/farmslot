import { memo, useMemo } from 'react';
import { Alert, Linking, Pressable, type StyleProp, Text, type TextStyle } from 'react-native';

import { nativeMessageCopyLabel, textLinkParts } from '@farmslot/protocol/client-cache';

import { nativeStyles as styles } from '../styles/native-conversation.styles';
import { useCopyText } from '../use-copy-text';

/** Copies one message's exact text; shows Copied, or Copy failed, after the copy. */
export function NativeCopyButton({
  text,
  action = 'Copy',
  testID = 'companion-native-copy',
}: {
  text: string;
  /** The label before a copy: what gets copied. */
  action?: string;
  testID?: string;
}) {
  const { copied, copy } = useCopyText(text);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      style={styles.messageToggle}
      onPress={() => void copy()}
    >
      <Text style={styles.buttonText}>{nativeMessageCopyLabel(copied, action)}</Text>
    </Pressable>
  );
}

/** Opens an http(s) address in the phone's browser; a refusal is shown, not dropped. */
function openWebLink(href: string) {
  Linking.openURL(href).catch((error: Error) => Alert.alert('Could not open link', error.message));
}

/**
 * Selectable message text whose http(s) addresses open in the browser. The text is split
 * once per text, not on every render of the row.
 */
export const NativeLinkedText = memo(function NativeLinkedText({
  text,
  style,
}: {
  text: string;
  style: StyleProp<TextStyle>;
}) {
  const parts = useMemo(() => textLinkParts(text), [text]);
  return (
    <Text selectable style={style}>
      {parts.map(({ text: run, href }, index) =>
        href ? (
          <Text
            key={index}
            testID="companion-native-link"
            accessibilityRole="link"
            style={styles.link}
            onPress={() => openWebLink(href)}
          >
            {run}
          </Text>
        ) : (
          run
        ),
      )}
    </Text>
  );
});
