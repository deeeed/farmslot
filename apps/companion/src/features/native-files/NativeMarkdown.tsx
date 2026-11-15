import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { memo, useCallback } from 'react';
import { Alert, Linking } from 'react-native';

import { recordNativeMarkdown } from '../../farmslot/native-render-proof';
import {
  nativeFileLocation,
  nativeFileRouteParams,
  type NativeWorkspaceTarget,
} from '../../lib/native-workspace-target';
import {
  fileChipClipboardPath,
  fileChipMenu,
  resolveFileChipTarget,
} from '../../t3/features/threads/fileChipMenu';
import { resolveMarkdownLinkPresentation } from '../../t3/lib/markdownLinks';
import { SelectableMarkdownText } from '../../t3/native/SelectableMarkdownText';

import { nativeMarkdownTextStyle } from './native-markdown-style';

function copy(text: string) {
  Clipboard.setStringAsync(text).catch((error: Error) =>
    Alert.alert('Could not copy', error.message),
  );
}

/**
 * A message's markdown, drawn natively. File links become chips that open the file viewer at
 * their line; web links open in the browser.
 */
export const NativeMarkdown = memo(function NativeMarkdown({
  text,
  entryKey,
  workspace,
}: {
  text: string;
  /** The timeline entry, for proofs. */
  entryKey: string;
  /** Present when the conversation can read its session's files. */
  workspace?: NativeWorkspaceTarget;
}) {
  const router = useRouter();
  const openFile = useCallback(
    (href: string) => {
      const location = workspace && nativeFileLocation(href, workspace.cwd);
      if (!workspace || !location) {
        Alert.alert('Cannot open this file', 'It is outside the session folder.');
        return;
      }
      router.push({
        pathname: '/native-file',
        params: { ...nativeFileRouteParams(workspace, location) },
      });
    },
    [router, workspace],
  );
  const onLinkPress = useCallback(
    (href: string) => {
      const link = resolveMarkdownLinkPresentation(href);
      if (link.kind === 'file') openFile(href);
      else if (link.kind === 'external' || link.href)
        Linking.openURL(link.kind === 'external' ? link.href : link.href!).catch((error: Error) =>
          Alert.alert('Could not open link', error.message),
        );
    },
    [openFile],
  );
  const fileContextMenu = useCallback(
    (href: string) => {
      const target = resolveFileChipTarget(href, workspace?.cwd);
      return target ? fileChipMenu(target) : undefined;
    },
    [workspace?.cwd],
  );
  const onFileContextMenuAction = useCallback(
    (href: string, actionId: string) => {
      const target = resolveFileChipTarget(href, workspace?.cwd);
      if (!target) return;
      if (actionId === 'open-file') openFile(href);
      else if (actionId === 'copy-full-path' || actionId === 'copy-relative-path') {
        const path = fileChipClipboardPath(target, actionId);
        if (path) copy(path);
      }
    },
    [openFile, workspace?.cwd],
  );
  const sessionId = workspace?.sessionId;
  const onRendered = useCallback(
    (rendered: Parameters<typeof recordNativeMarkdown>[2]) => {
      if (sessionId) recordNativeMarkdown(sessionId, entryKey, rendered);
    },
    [sessionId, entryKey],
  );
  return (
    <SelectableMarkdownText
      testID="companion-native-markdown"
      markdown={text}
      textStyle={nativeMarkdownTextStyle}
      onLinkPress={onLinkPress}
      fileContextMenu={fileContextMenu}
      onFileContextMenuAction={onFileContextMenuAction}
      onRendered={onRendered}
    />
  );
});
