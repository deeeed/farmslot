import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Linking,
  Pressable,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { type AcceptanceClaimRow } from '@farmslot/review-dispatch';
import { publicationGateColors } from '@farmslot/theme';

import { fonts } from '../lib/theme';

import { VisualClaimJudgment } from './VisualClaimJudgment';

function ClaimState({
  claim,
  palette,
}: {
  claim: AcceptanceClaimRow;
  palette: (typeof publicationGateColors)['light' | 'dark'];
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  const previous = useRef(claim.state);
  useEffect(() => {
    if (previous.current === claim.state) return;
    previous.current = claim.state;
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!active || reduced) return;
      opacity.setValue(0.45);
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
    return () => {
      active = false;
      opacity.stopAnimation();
    };
  }, [claim.state, opacity]);
  return (
    <Animated.Text
      accessibilityLabel={[claim.state, claim.detail].filter(Boolean).join('. ')}
      style={{
        opacity,
        // A status, not a control: a tinted pill with no outline.
        color: palette[claim.tone],
        backgroundColor: palette[`${claim.tone}Surface`],
        borderRadius: 999,
        overflow: 'hidden',
        paddingHorizontal: 10,
        paddingVertical: 2,
        fontWeight: '600',
        alignSelf: 'flex-start',
      }}
    >
      {claim.state}
    </Animated.Text>
  );
}

/** One AC list for gates, previews and evidence panels. */
export function AcceptanceClaimList({
  rows,
  disabled,
  onRecord,
  onFocus,
  canFocus,
  renderDetails,
  hasDetails,
  onBusyChange,
  testIDPrefix = 'companion-ac-row',
}: {
  rows: readonly AcceptanceClaimRow[];
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onRecord?: (id: string, verdict: 'confirmed' | 'rejected', reason?: string) => Promise<void>;
  onFocus?: (id: string) => void;
  /** False hides a row's Review evidence: there is nothing for it to open. */
  canFocus?: (id: string) => boolean;
  renderDetails?: (id: string) => ReactNode;
  /** Whether a row has anything behind "More"; without it, More shows whenever there are details. */
  hasDetails?: (id: string) => boolean;
  testIDPrefix?: string;
}) {
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const button = {
    minHeight: 44,
    minWidth: 44,
    padding: 12,
    justifyContent: 'center' as const,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 8,
    backgroundColor: palette.surface,
  };
  return (
    <View accessibilityLabel="Acceptance criteria">
      {rows.map((claim) => (
        <View
          key={claim.id}
          testID={`${testIDPrefix}-${claim.id}`}
          style={{
            paddingVertical: 6,
            paddingHorizontal: 12,
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            borderTopWidth: 1,
            borderColor: palette.border,
            backgroundColor: palette.background,
          }}
        >
          <Text
            style={{
              color: palette.secondary,
              fontSize: fonts.sizeMd,
              fontWeight: '600',
              minWidth: 44,
            }}
          >
            {claim.id}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${claim.text} Expand criterion`}
            accessibilityState={{ expanded: expanded.has(claim.id) }}
            style={{ flex: 1, minWidth: 150, minHeight: 44, justifyContent: 'center' }}
            onPress={() =>
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(claim.id)) next.delete(claim.id);
                else next.add(claim.id);
                return next;
              })
            }
          >
            <Text
              numberOfLines={expanded.has(claim.id) ? undefined : 2}
              style={{ color: palette.text, fontSize: fonts.sizeMd }}
            >
              {claim.text}
            </Text>
          </Pressable>
          <ClaimState claim={claim} palette={palette} />
          {canFocus?.(claim.id) === false ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Review evidence for ${claim.id}`}
              onPress={() => onFocus?.(claim.id)}
              disabled={!onFocus}
              style={button}
            >
              <Text style={{ color: palette.text }}>
                Review evidence
                {claim.judgment?.media.clip
                  ? ` · ${Math.floor(claim.judgment.media.clip.startMs / 1000)}s`
                  : ''}
              </Text>
            </Pressable>
          )}
          {claim.judgment && claim.judgment.claim.status?.proofMode !== 'state' ? (
            <VisualClaimJudgment
              row={claim.judgment}
              onRecord={onRecord}
              disabled={disabled || busy}
              onBusyChange={(value) => {
                setBusy(value);
                onBusyChange?.(value);
              }}
            />
          ) : null}
          {renderDetails && (hasDetails?.(claim.id) ?? true) ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`More actions for ${claim.id}`}
                accessibilityState={{ expanded: expanded.has(claim.id) }}
                onPress={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(claim.id)) next.delete(claim.id);
                    else next.add(claim.id);
                    return next;
                  })
                }
                style={button}
              >
                <Text style={{ color: palette.text }}>More</Text>
              </Pressable>
            </>
          ) : null}
          {expanded.has(claim.id) ? (
            <View style={{ width: '100%', gap: 8 }}>
              {claim.detail ? (
                <Text style={{ color: palette.secondary }}>{claim.detail}</Text>
              ) : null}
              {claim.origin ? (
                <View testID="companion-acceptance-origin">
                  <Pressable
                    style={{ minHeight: 44, justifyContent: 'center' }}
                    disabled={!claim.origin.url}
                    accessibilityRole="link"
                    onPress={() => {
                      if (claim.origin?.url)
                        void Linking.openURL(claim.origin.url).catch((error: Error) =>
                          Alert.alert('Cannot open source', error.message),
                        );
                    }}
                  >
                    <Text style={{ color: palette.secondary }}>{claim.origin.label}</Text>
                  </Pressable>
                  <Text style={{ color: palette.secondary }}>
                    {claim.origin.body ?? claim.origin.reference}
                  </Text>
                </View>
              ) : null}
              {hasDetails?.(claim.id) === false ? null : renderDetails?.(claim.id)}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
