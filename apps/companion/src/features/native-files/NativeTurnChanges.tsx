import { Pressable, Text } from 'react-native';

import type { NativeTurnChanges, NativeTurnFile } from '@farmslot/protocol';

import { useViewToggle } from '../../components/view-state';
import type { NativeWorkspaceTarget } from '../../lib/native-workspace-target';
import { nativeStyles as styles } from '../native-conversation/styles/native-conversation.styles';

import { NativeDiffView } from './NativeDiffView';
import { useNativeTurnDiff } from './use-native-turn-diff';

/** The files a turn changed; each opens its diff between the turn's checkpoints. */
export function NativeTurnChangesList({
  entryKey,
  sequence,
  changes,
  workspace,
  onDisclosure,
}: {
  entryKey: string;
  sequence: number;
  changes: NativeTurnChanges;
  /** Absent when this account cannot read turn diffs. */
  workspace?: NativeWorkspaceTarget;
  onDisclosure: () => void;
}) {
  if (changes.unavailable) return <Text style={styles.muted}>{changes.unavailable}</Text>;
  return (
    <>
      {changes.files.map((file) => (
        <NativeTurnFileDiff
          key={`${entryKey}:${file.path}`}
          entryKey={entryKey}
          sequence={sequence}
          file={file}
          workspace={workspace}
          onDisclosure={onDisclosure}
        />
      ))}
      {changes.truncated ? <Text style={styles.muted}>More files changed.</Text> : null}
    </>
  );
}

function NativeTurnFileDiff({
  entryKey,
  sequence,
  file,
  workspace,
  onDisclosure,
}: {
  entryKey: string;
  sequence: number;
  file: NativeTurnFile;
  workspace?: NativeWorkspaceTarget;
  onDisclosure: () => void;
}) {
  const [open, setOpen] = useViewToggle(`native-turn:${entryKey}:${file.path}`);
  const diff = useNativeTurnDiff(workspace, sequence, file.path, open);
  const counts =
    file.additions === undefined ? 'binary' : `+${file.additions} −${file.deletions ?? 0}`;
  return (
    <>
      <Pressable
        testID="companion-native-turn-file"
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !workspace }}
        disabled={!workspace}
        style={styles.messageToggle}
        onPress={() => {
          onDisclosure();
          setOpen(!open);
        }}
      >
        <Text style={workspace ? styles.buttonText : styles.muted}>
          {file.path} · {file.status} · {counts}
          {workspace ? ` · ${open ? 'Hide' : 'Diff'}` : ''}
        </Text>
      </Pressable>
      {open ? (
        diff.data ? (
          <NativeDiffView
            diffText={diff.data.diff}
            title={file.path}
            source="turn"
            proof={
              workspace
                ? { sessionId: workspace.sessionId, key: `turn:${entryKey}:${file.path}` }
                : undefined
            }
          />
        ) : (
          <Text style={diff.status === 'error' ? styles.error : styles.muted}>
            {diff.status === 'error'
              ? (diff.error?.message ?? 'Could not read the diff.')
              : 'Loading diff…'}
          </Text>
        )
      ) : null}
    </>
  );
}
