import { useState } from 'react';
import { Pressable, Text, TextInput, useColorScheme, View } from 'react-native';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import { publicationGateColors } from '@farmslot/theme';

/** Shared by the gate and Compare by AC. Only Issue asks a person for prose. */
export function VisualClaimJudgment({
  row,
  onRecord,
  disabled = false,
}: {
  row: EvidenceReviewJudgmentRow;
  onRecord?: (id: string, verdict: 'confirmed' | 'rejected', reason?: string) => Promise<void>;
  disabled?: boolean;
}) {
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const [issue, setIssue] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const delegated = row.reviewKind === 'lead-agent-reviewed';
  const pending =
    row.claim.status?.verdict === 'awaiting-review' &&
    ['visual', 'mixed'].includes(row.claim.status.proofMode ?? '');
  const blocked = disabled || busy || !row.reviewKind || !onRecord;
  const record = async (verdict: 'confirmed' | 'rejected') => {
    if (!onRecord || busy) return;
    setBusy(true);
    setError('');
    try {
      await onRecord(
        row.claim.id,
        verdict,
        verdict === 'confirmed' && !delegated ? undefined : reason,
      );
      setIssue(false);
      setReason('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
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
    <View style={{ gap: 8 }}>
      <Text style={{ color: palette.text }}>
        Agent review ·{' '}
        {row.prevalidation
          ? row.prevalidation.verdict === 'confirmed'
            ? 'Looks right'
            : 'Issue'
          : 'Not recorded'}
      </Text>
      {row.prevalidation ? (
        <Text style={{ color: palette.text }}>{row.prevalidation.reason}</Text>
      ) : null}
      {row.claim.reviewLabels.length ? (
        <Text style={{ color: palette.secondary }}>{row.claim.reviewLabels.join(' · ')}</Text>
      ) : null}
      {row.claim.proofKinds.includes('assertion') ? (
        <Text style={{ color: palette.secondary }}>Recorded checks</Text>
      ) : null}
      {row.reviewKind || pending ? (
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
              disabled={blocked || (delegated && !reason.trim())}
              onPress={() => void record('confirmed')}
              style={buttonStyle}
            >
              <Text style={{ color: palette.text }}>Looks right</Text>
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
                disabled={blocked || !reason.trim()}
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
        <Text accessibilityRole="alert" style={{ color: palette.warning }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
