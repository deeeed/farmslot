import type { GestureResponderEvent } from 'react-native';

interface BacklogReadyControl {
  itemId: string;
  testId: string;
  disabled: boolean;
}

export interface BacklogReadyTouch extends BacklogReadyControl {
  kind: 'native-touch-start';
  sequence: number;
  receivedAt: number;
  nativeTimestamp: number;
  nativeTarget: GestureResponderEvent['nativeEvent']['target'];
  pageX: number;
  pageY: number;
}

const touches: BacklogReadyTouch[] = [];
let sequence = 0;

export function isBacklogReadyTouchProofEnabled(): boolean {
  return Boolean(
    typeof __DEV__ !== 'undefined' &&
    __DEV__ &&
    process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE === '1',
  );
}

/** Observe native input only. This never claims a responder, invokes an action or changes UI state. */
export function recordBacklogReadyTouch(
  event: GestureResponderEvent['nativeEvent'],
  control: BacklogReadyControl,
): void {
  if (!isBacklogReadyTouchProofEnabled()) return;
  touches.push({
    ...control,
    kind: 'native-touch-start',
    sequence: ++sequence,
    receivedAt: Date.now(),
    nativeTimestamp: event.timestamp,
    nativeTarget: event.target,
    pageX: event.pageX,
    pageY: event.pageY,
  });
  if (touches.length > 32) touches.shift();
}

export function readBacklogReadyTouches(): BacklogReadyTouch[] {
  return isBacklogReadyTouchProofEnabled() ? touches.map((touch) => ({ ...touch })) : [];
}
