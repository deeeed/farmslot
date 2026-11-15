import { Stack, useRouter } from 'expo-router';
import { Alert, Linking, Pressable, Text, View } from 'react-native';

import { nativeLinkedFileLocation } from '../../lib/native-workspace-target';
import { FileMarkdownPreview } from '../../t3/features/files/FileMarkdownPreview';
import { SourceFileSurface } from '../../t3/features/files/SourceFileSurface';
import { resolveMarkdownLinkPresentation } from '../../t3/lib/markdownLinks';
import { fileLinkLabel } from '../../t3/shared/fileLinks';

import { nativeFileStyles as styles } from './styles/native-file.styles';
import { nativeMarkdownTextStyle } from './native-markdown-style';
import type { useNativeFileController } from './use-native-file-controller';

type Screen = ReturnType<typeof useNativeFileController>;

/** One file of a native session's folder: highlighted source at a line, or rendered markdown. */
export function NativeFileScreen({ viewModel: vm, actions }: Screen) {
  const router = useRouter();
  const title = vm.path ? fileLinkLabel({ path: vm.path, line: vm.line }, new Map()) : 'File';
  // Links in a markdown file resolve against that file's folder, or the session folder.
  const openLink = (href: string) => {
    const link = resolveMarkdownLinkPresentation(href);
    if (link.kind === 'external')
      Linking.openURL(link.href).catch((error: Error) =>
        Alert.alert('Could not open link', error.message),
      );
    if (link.kind !== 'file' || !vm.route || !vm.path) return;
    const location = nativeLinkedFileLocation(href, vm.path, vm.route.cwd);
    if (!location) {
      Alert.alert('Cannot open this file', 'It is outside the session folder.');
      return;
    }
    router.push({
      pathname: '/native-file',
      params: {
        sessionId: vm.route.target.sessionId,
        executionNodeId: vm.route.target.executionNodeId,
        path: location.path,
        ...(location.line ? { line: String(location.line) } : {}),
        ...(vm.route.cwd ? { cwd: vm.route.cwd } : {}),
        ...(vm.route.target.worker ?? {}),
      },
    });
  };
  return (
    <View testID="companion-screen-native-file" style={styles.container}>
      <Stack.Screen options={{ title }} />
      <View style={styles.bar}>
        <Text testID="companion-native-file-path" numberOfLines={1} style={styles.path}>
          {vm.path}
          {vm.line ? `:${vm.line}` : ''}
        </Text>
        {vm.markdown ? (
          <Pressable
            testID="companion-native-file-markdown-toggle"
            accessibilityRole="button"
            style={styles.toggle}
            onPress={() => actions.setMode(vm.mode === 'rendered' ? 'raw' : 'rendered')}
          >
            <Text style={styles.toggleText}>{vm.mode === 'rendered' ? 'Raw' : 'Rendered'}</Text>
          </Pressable>
        ) : null}
        {vm.mode !== 'rendered' ? (
          <Pressable
            testID="companion-native-file-select"
            accessibilityRole="button"
            accessibilityState={{ selected: vm.selectable }}
            style={styles.toggle}
            onPress={() => actions.setSelectable(!vm.selectable)}
          >
            <Text style={styles.toggleText}>{vm.selectable ? 'Done' : 'Select'}</Text>
          </Pressable>
        ) : null}
      </View>
      {vm.content === undefined ? (
        <Text style={vm.status === 'error' ? styles.error : styles.muted}>
          {vm.status === 'error' ? (vm.error ?? 'Could not read the file.') : 'Loading file…'}
        </Text>
      ) : vm.mode === 'rendered' ? (
        <FileMarkdownPreview
          markdown={vm.content}
          textStyle={nativeMarkdownTextStyle}
          onLinkPress={openLink}
          onRendered={actions.onMarkdownRendered}
        />
      ) : (
        <SourceFileSurface
          contents={vm.content}
          path={vm.path ?? ''}
          initialLine={vm.line}
          selectable={vm.selectable}
          onRendered={actions.onSourceRendered}
          onDebug={actions.onSourceDebug}
        />
      )}
    </View>
  );
}
