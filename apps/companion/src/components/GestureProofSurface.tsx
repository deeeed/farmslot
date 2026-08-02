import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { colors, fonts, radii, spacing } from '../lib/theme';

const gestureProofEnabled = process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE === '1';
const gestureHandlersEnabled =
  process.env.EXPO_PUBLIC_FARMSLOT_DISABLE_GESTURE_PROOF_HANDLERS !== '1';

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function GestureProofSurface() {
  const [listMoved, setListMoved] = useState(false);
  const [panMoved, setPanMoved] = useState(false);
  const [sliderValue, setSliderValue] = useState(20);
  const [sliderMoved, setSliderMoved] = useState(false);
  const [held, setHeld] = useState(false);
  const sliderStart = useRef(sliderValue);
  const sliderValueRef = useRef(sliderValue);
  const markPanMoved = useCallback(() => setPanMoved(true), []);
  const updateSlider = useCallback((translationX: number) => {
    const nextValue = clamp(sliderStart.current + translationX / 2);
    sliderValueRef.current = nextValue;
    setSliderValue(nextValue);
    if (Math.abs(translationX) >= 20) setSliderMoved(true);
  }, []);
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(gestureHandlersEnabled)
        .runOnJS(true)
        .minDistance(2)
        .onUpdate((event) => {
          if (Math.abs(event.translationX) + Math.abs(event.translationY) >= 20) {
            markPanMoved();
          }
        }),
    [markPanMoved],
  );
  const sliderGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(gestureHandlersEnabled)
        .runOnJS(true)
        .minDistance(2)
        .onBegin(() => {
          sliderStart.current = sliderValueRef.current;
        })
        .onUpdate((event) => {
          updateSlider(event.translationX);
        }),
    [updateSlider],
  );

  if (!gestureProofEnabled) return null;

  return (
    <View style={styles.card} testID="gesture-proof-surface">
      <Text style={styles.eyebrow}>Recipe gesture proof</Text>
      <Text style={styles.title}>Continuous input surface</Text>

      <ScrollView
        horizontal
        testID="gesture-proof-list"
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onScroll={(event) => {
          if (gestureHandlersEnabled && event.nativeEvent.contentOffset.x >= 20) setListMoved(true);
        }}
        scrollEventThrottle={16}
      >
        {Array.from({ length: 10 }, (_, index) => (
          <View key={index} style={styles.listItem}>
            <Text style={styles.itemText}>Item {index + 1}</Text>
          </View>
        ))}
      </ScrollView>
      <Text testID="gesture-list-status" style={styles.status}>
        {listMoved ? 'Gesture list moved' : 'Gesture list ready'}
      </Text>

      <GestureDetector gesture={panGesture}>
        <View
          testID="gesture-proof-pan"
          accessible
          accessibilityLabel="Gesture pan surface"
          style={styles.panSurface}
        >
          <Text style={styles.itemText}>
            {panMoved ? 'Gesture pan moved' : 'Gesture pan ready'}
          </Text>
        </View>
      </GestureDetector>
      <Text testID="gesture-pan-status" style={styles.status}>
        {panMoved ? 'Gesture pan moved' : 'Gesture pan ready'}
      </Text>

      <GestureDetector gesture={sliderGesture}>
        <View
          testID="gesture-proof-slider"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Gesture proof slider"
          accessibilityValue={{ min: 0, max: 100, now: sliderValue }}
          style={styles.slider}
        >
          <View style={[styles.sliderFill, { width: `${sliderValue}%` }]} />
        </View>
      </GestureDetector>
      <Text testID="gesture-slider-status" style={styles.status}>
        {sliderMoved ? 'Gesture slider moved' : 'Gesture slider ready'}
      </Text>

      <Pressable
        testID="gesture-proof-hold"
        accessibilityRole="button"
        style={styles.holdButton}
        delayLongPress={500}
        onLongPress={gestureHandlersEnabled ? () => setHeld(true) : undefined}
      >
        <Text style={styles.holdText}>
          {held ? 'Gesture long press received' : 'Hold to prove'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.xl,
  },
  eyebrow: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '800',
  },
  list: {
    maxHeight: 72,
  },
  listContent: {
    gap: spacing.sm,
  },
  listItem: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderRadius: radii.md,
    height: 64,
    justifyContent: 'center',
    width: 104,
  },
  itemText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  status: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
  },
  panSurface: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    height: 72,
    justifyContent: 'center',
  },
  slider: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.md,
    height: 44,
    overflow: 'hidden',
  },
  sliderFill: {
    backgroundColor: colors.accent,
    height: '100%',
  },
  holdButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  holdText: {
    color: colors.bgBase,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
});
