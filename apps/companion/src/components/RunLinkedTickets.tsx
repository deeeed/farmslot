import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { parseRunLinkedTicketRefs, type Run, runLinkedTicketsView } from '@farmslot/protocol';

import { colors, fonts } from '../lib/theme';

/** One renderer for run cards and detail; only detail supplies the metadata edit action. */
export function RunLinkedTickets({
  run,
  onSave,
  disabled = false,
}: {
  run: Run;
  onSave?: (refs: string[]) => Promise<void>;
  disabled?: boolean;
}) {
  const view = runLinkedTicketsView(run);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const save = async () => {
    if (!onSave || disabled || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave(parseRunLinkedTicketRefs(draft));
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!view.tickets.length && !view.pr && !onSave) return null;
  return (
    <View testID="run-linked-tickets" style={styles.container}>
      <View style={styles.row}>
        <Text style={styles.label}>Tickets</Text>
        {view.tickets.map((ticket) =>
          ticket.url ? (
            <Pressable
              key={ticket.ref}
              accessibilityRole="link"
              style={styles.chip}
              onPress={() => void open(ticket.url!)}
            >
              <Text style={styles.link}>{ticket.ref}</Text>
            </Pressable>
          ) : (
            <Text key={ticket.ref} style={styles.unlinked}>
              {ticket.ref}
            </Text>
          ),
        )}
        {view.pr ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open run PR"
            style={styles.chip}
            onPress={() => view.pr && void open(view.pr.url)}
          >
            <Text style={styles.link}>PR ↗</Text>
          </Pressable>
        ) : null}
        {onSave && !editing ? (
          <Pressable
            style={styles.chip}
            accessibilityRole="button"
            disabled={disabled || busy}
            onPress={() => {
              setDraft(view.operatorRefs.join(', '));
              setError('');
              setEditing(true);
            }}
          >
            <Text style={styles.link}>{view.operatorRefs.length ? 'Edit' : '+ Add'}</Text>
          </Pressable>
        ) : null}
      </View>
      {editing ? (
        <View>
          <Text style={styles.label}>Additional tickets</Text>
          <TextInput
            accessibilityLabel="Additional Jira tickets"
            placeholder="TEAM-123, TEAM-456"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            value={draft}
            onChangeText={setDraft}
            editable={!busy && !disabled}
            style={styles.input}
          />
          <View style={styles.row}>
            <Pressable
              style={styles.chip}
              accessibilityRole="button"
              disabled={disabled || busy}
              onPress={() => void save()}
            >
              <Text style={styles.link}>{busy ? 'Saving…' : 'Save'}</Text>
            </Pressable>
            <Pressable
              style={styles.chip}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => setEditing(false)}
            >
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { minWidth: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  label: { color: colors.textSecondary, fontSize: fonts.sizeSm },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 6,
    borderColor: colors.accent,
    borderWidth: 1,
  },
  link: { color: colors.accent, fontSize: fonts.sizeSm },
  unlinked: { color: colors.textSecondary, fontSize: fonts.sizeSm, padding: 8 },
  input: {
    minHeight: 44,
    color: colors.textPrimary,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: 6,
    padding: 8,
  },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
});
