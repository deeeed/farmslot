import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, useColorScheme, View } from 'react-native';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import { validVisualJudgmentReason } from '@farmslot/protocol';
import { publicationGateColors } from '@farmslot/theme';

/** Shared by the gate and Compare by AC. Only Issue asks a person for prose. */
export function VisualClaimJudgment({
  row,
  onRecord,
  disabled = false,
  onBusyChange,
}: {
  row: EvidenceReviewJudgmentRow;
  onRecord?: (id: string, verdict: 'confirmed' | 'rejected', reason?: string) => Promise<void>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const [issue, setIssue] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const checked = row.claim.proofKinds.includes('person-reviewed') && !row.pending;
  const delegated = row.reviewKind === 'lead-agent-reviewed';
  const blocked = disabled || busy || !row.reviewKind || !onRecord;
  const record = async (verdict: 'confirmed' | 'rejected') => {
    if (!onRecord || busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      await onRecord(
        row.claim.id,
        verdict,
        validVisualJudgmentReason(row.reviewKind ?? undefined, verdict) ? undefined : reason,
      );
      setIssue(false);
      setReason('');
      setChanging(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  const buttonStyle = {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center' as const,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 8,
    backgroundColor: palette.surface,
  };
  return (
    <View style={{ gap: 8 }} accessibilityState={{ busy }}>
      {checked && !changing && !busy ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Change judgment for ${row.claim.id}`}
          disabled={blocked}
          onPress={() => setChanging(true)}
          style={buttonStyle}
        >
          <Text style={{ color: palette.text }}>Change</Text>
        </Pressable>
      ) : row.reviewKind || row.pending ? (
        <>
          {issue || delegated ? (
            <TextInput
              accessibilityLabel={`Issue reason for ${row.claim.id}`}
              placeholder="Reason"
              placeholderTextColor={palette.secondary}
              value={reason}
              onChangeText={setReason}
              editable={!busy && !disabled}
              multiline
              style={{ ...buttonStyle, color: palette.text, minHeight: 60 }}
            />
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Looks right for ${row.claim.id}`}
              disabled={
                blocked ||
                !validVisualJudgmentReason(row.reviewKind ?? undefined, 'confirmed', reason)
              }
              onPress={() => void record('confirmed')}
              style={buttonStyle}
            >
              {busy ? <ActivityIndicator size="small" color={palette.text} /> : null}
              <Text style={{ color: palette.text }}>{busy ? 'Checking…' : 'Looks right'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Issue for ${row.claim.id}`}
              disabled={blocked}
              onPress={() => setIssue(!issue)}
              style={buttonStyle}
            >
              <Text style={{ color: palette.text }}>Issue</Text>
            </Pressable>
            {issue ? (
              <Pressable
                accessibilityRole="button"
                disabled={
                  blocked ||
                  !validVisualJudgmentReason(row.reviewKind ?? undefined, 'rejected', reason)
                }
                onPress={() => void record('rejected')}
                style={buttonStyle}
              >
                <Text style={{ color: palette.text }}>Record issue</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: palette.issue }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
