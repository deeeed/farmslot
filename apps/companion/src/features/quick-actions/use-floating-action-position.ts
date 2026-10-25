import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, PanResponder, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SIZE = 48;
const MARGIN = 12;
const POSITION_KEY = '@farmslot:copilotFabPosition';
interface Point {
  x: number;
  y: number;
}

function storedPosition(raw: string): Point | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null; // A malformed convenience preference falls back to the visible default.
  }
  return value &&
    typeof value === 'object' &&
    'x' in value &&
    'y' in value &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
    ? { x: value.x, y: value.y }
    : null;
}

export function useFloatingActionPosition(pathname: string, composerHeight = 0) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [keyboardTop, setKeyboardTop] = useState(Number.POSITIVE_INFINITY);
  const [position, setPosition] = useState<Point | null>(null);
  const positionRef = useRef<Point | null>(null);
  const dragStart = useRef<Point>({ x: 0, y: 0 });
  const persistenceError = useRef<string | null>(null);
  const loadedPosition = useRef(false);
  const tabRoute =
    /^\/(runs|fleet|prs|inbox|settings|advanced|backlog|roadmap|copilot|workers)(\/|$)/.test(
      pathname,
    );
  const clamp = useCallback(
    (point: Point): Point => {
      const minX = MARGIN + insets.left;
      const minY = MARGIN + insets.top;
      return {
        x: Math.min(Math.max(minX, width - insets.right - MARGIN - SIZE), Math.max(minX, point.x)),
        y: Math.min(
          Math.max(
            minY,
            Math.min(height, keyboardTop) -
              insets.bottom -
              MARGIN -
              (tabRoute ? 76 : 96) -
              composerHeight -
              SIZE,
          ),
          Math.max(minY, point.y),
        ),
      };
    },
    [composerHeight, height, insets, keyboardTop, tabRoute, width],
  );
  const defaultPosition = useMemo(() => clamp({ x: width, y: height }), [clamp, height, width]);
  const current = position ?? defaultPosition;
  useEffect(() => {
    positionRef.current = current;
  }, [current]);
  useEffect(() => {
    setPosition((point) => (point ? clamp(point) : point));
  }, [clamp]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) =>
      setKeyboardTop(event.endCoordinates.screenY),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () =>
      setKeyboardTop(Number.POSITIVE_INFINITY),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    if (loadedPosition.current) return;
    loadedPosition.current = true;
    let disposed = false;
    AsyncStorage.getItem(POSITION_KEY).then(
      (raw) => {
        if (disposed || !raw) return;
        const point = storedPosition(raw);
        if (point) setPosition(clamp(point));
      },
      (error: unknown) => {
        // Position persistence is optional; keep the usable default on storage failure.
        persistenceError.current = String(error);
      },
    );
    return () => {
      disposed = true;
    };
  }, [clamp]);
  const persist = useCallback((point: Point) => {
    AsyncStorage.setItem(POSITION_KEY, JSON.stringify(point)).then(
      () => {
        persistenceError.current = null;
      },
      (error: unknown) => {
        // Drag already moved the button; storage failure retains that in-memory point.
        persistenceError.current = String(error);
      },
    );
  }, []);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 5 || Math.abs(gesture.dy) > 5,
        onPanResponderGrant: () => {
          dragStart.current = positionRef.current ?? defaultPosition;
        },
        onPanResponderMove: (_event, gesture) =>
          setPosition(
            clamp({ x: dragStart.current.x + gesture.dx, y: dragStart.current.y + gesture.dy }),
          ),
        onPanResponderRelease: () => {
          const point = clamp(positionRef.current ?? defaultPosition);
          setPosition(point);
          persist(point);
        },
        onPanResponderTerminate: () => {
          const point = clamp(positionRef.current ?? defaultPosition);
          setPosition(point);
          persist(point);
        },
      }),
    [clamp, defaultPosition, persist],
  );
  return { panHandlers: pan.panHandlers, style: { left: current.x, top: current.y } };
}
