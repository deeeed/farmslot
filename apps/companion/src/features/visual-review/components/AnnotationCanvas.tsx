import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, type ScrollView } from 'react-native-gesture-handler';

import type { VisualReviewAnnotation } from '@farmslot/protocol';

import type { VisualReviewAnnotationInput } from '../../../lib/visual-review';
import { visualReviewStyles as styles } from '../styles/visual-review.styles';
import type {
  VisualReviewAnnotationMode,
  VisualReviewCaptureView,
} from '../visual-review-controller';

interface Size {
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampToStage(point: { x: number; y: number }, stage: Size): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(stage.width, point.x)),
    y: Math.max(0, Math.min(stage.height, point.y)),
  };
}

function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function Marker({
  annotation,
  number,
  stage,
  selected,
  scrollRef,
  onSelect,
  onMove,
}: {
  annotation: VisualReviewAnnotation;
  number: number;
  stage: Size;
  selected: boolean;
  scrollRef: RefObject<ScrollView | null>;
  onSelect: (annotationId: string) => void;
  onMove: (annotationId: string, delta: { x: number; y: number }) => void;
}) {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(2)
      .blocksExternalGesture(scrollRef)
      .onStart(() => onSelect(annotation.id))
      .onUpdate((event) => setDrag({ dx: event.translationX, dy: event.translationY }))
      .onEnd((event) =>
        onMove(annotation.id, {
          x: event.translationX / stage.width,
          y: event.translationY / stage.height,
        }),
      )
      .onFinalize(() => setDrag(null));
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd(() => onSelect(annotation.id));
    return Gesture.Exclusive(pan, tap);
  }, [annotation.id, onMove, onSelect, scrollRef, stage.height, stage.width]);
  const color = annotation.color ?? '#5855ee';
  // The preview uses the same bounds the controller applies when the drag ends.
  const maxX = annotation.shape === 'area' ? 1 - annotation.width : 1;
  const maxY = annotation.shape === 'area' ? 1 - annotation.height : 1;
  const left = Math.max(
    0,
    Math.min(maxX * stage.width, annotation.x * stage.width + (drag?.dx ?? 0)),
  );
  const top = Math.max(
    0,
    Math.min(maxY * stage.height, annotation.y * stage.height + (drag?.dy ?? 0)),
  );
  const label = (
    <Text style={styles.markerText} accessibilityElementsHidden>
      {number}
    </Text>
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        testID={`visual-review-marker-${annotation.id}`}
        accessibilityRole="button"
        accessibilityLabel={`Annotation ${number}${selected ? ', selected' : ''}`}
        // Claim the touch so the canvas does not also treat it as a new point.
        onStartShouldSetResponder={() => true}
        style={
          annotation.shape === 'area'
            ? [
                styles.area,
                {
                  left,
                  top,
                  width: annotation.width * stage.width,
                  height: annotation.height * stage.height,
                  borderColor: color,
                  backgroundColor: `${color}33`,
                },
                selected && styles.markerSelected,
              ]
            : [
                styles.point,
                { left, top, backgroundColor: color },
                selected && styles.markerSelected,
              ]
        }
      >
        {annotation.shape === 'area' ? (
          <View style={[styles.areaBadge, { backgroundColor: color }]}>{label}</View>
        ) : (
          label
        )}
      </View>
    </GestureDetector>
  );
}

/**
 * Screenshot stage in intrinsic-image coordinates. Point mode drops a marker on tap, area
 * mode draws on drag, and any marker can be dragged or tapped to select it.
 */
export function AnnotationCanvas({
  capture,
  annotations,
  selectedAnnotationId,
  mode,
  fullWidth,
  scrollRef,
  onAdd,
  onSelect,
  onMove,
}: {
  capture: VisualReviewCaptureView;
  annotations: VisualReviewAnnotation[];
  selectedAnnotationId: string | null;
  mode: VisualReviewAnnotationMode;
  fullWidth: boolean;
  scrollRef: RefObject<ScrollView | null>;
  onAdd: (input: VisualReviewAnnotationInput) => void;
  onSelect: (annotationId: string) => void;
  onMove: (annotationId: string, delta: { x: number; y: number }) => void;
}) {
  const windowSize = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(0);
  const [measured, setMeasured] = useState<Size | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [draftRect, setDraftRect] = useState<Rect | null>(null);
  const areaStart = useRef<{ x: number; y: number } | null>(null);
  const { uri, headers } = capture.image;

  useEffect(() => {
    setImageError(null);
    if (capture.width && capture.height) {
      setMeasured({ width: capture.width, height: capture.height });
      return;
    }
    setMeasured(null);
    let active = true;
    Image.getSizeWithHeaders(
      uri,
      headers ?? {},
      (width, height) => {
        if (active) setMeasured({ width, height });
      },
      (error) => {
        if (active) setImageError(`Could not load ${capture.artifactPath}: ${String(error)}`);
      },
    );
    return () => {
      active = false;
    };
  }, [capture.artifactPath, capture.height, capture.width, headers, uri]);

  const stage = useMemo<Size | null>(() => {
    if (!measured || containerWidth === 0) return null;
    const aspect = measured.height / measured.width;
    const maxHeight = fullWidth ? Number.POSITIVE_INFINITY : windowSize.height * 0.55;
    const width = Math.min(containerWidth, maxHeight / aspect);
    return { width, height: width * aspect };
  }, [containerWidth, fullWidth, measured, windowSize.height]);

  const areaGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(mode === 'area' && stage !== null)
        .runOnJS(true)
        .minDistance(8)
        .blocksExternalGesture(scrollRef)
        .onBegin((event) => {
          if (stage) areaStart.current = clampToStage(event, stage);
        })
        .onUpdate((event) => {
          if (areaStart.current && stage) {
            setDraftRect(rectBetween(areaStart.current, clampToStage(event, stage)));
          }
        })
        .onEnd((event) => {
          if (!areaStart.current || !stage) return;
          const rect = rectBetween(areaStart.current, clampToStage(event, stage));
          onAdd({
            shape: 'area',
            x: rect.x / stage.width,
            y: rect.y / stage.height,
            width: rect.width / stage.width,
            height: rect.height / stage.height,
          });
        })
        .onFinalize(() => {
          areaStart.current = null;
          setDraftRect(null);
        }),
    [mode, onAdd, scrollRef, stage],
  );

  return (
    <View onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
      {imageError ? (
        <Text style={styles.error}>{imageError}</Text>
      ) : stage ? (
        <GestureDetector gesture={areaGesture}>
          <Pressable
            testID="visual-review-canvas"
            accessibilityLabel={`${capture.platform} capture, ${mode} mode`}
            disabled={mode !== 'point'}
            style={[styles.canvasViewport, { width: stage.width, height: stage.height }]}
            onPress={(event) =>
              onAdd({
                shape: 'point',
                x: event.nativeEvent.locationX / stage.width,
                y: event.nativeEvent.locationY / stage.height,
              })
            }
          >
            <Image
              source={capture.image}
              style={{ width: stage.width, height: stage.height }}
              resizeMode="stretch"
              onError={(event) =>
                setImageError(`Could not load ${capture.artifactPath}: ${event.nativeEvent.error}`)
              }
            />
            {annotations.map((annotation, index) => (
              <Marker
                key={annotation.id}
                annotation={annotation}
                number={index + 1}
                stage={stage}
                selected={annotation.id === selectedAnnotationId}
                scrollRef={scrollRef}
                onSelect={onSelect}
                onMove={onMove}
              />
            ))}
            {draftRect ? (
              <View
                pointerEvents="none"
                style={[
                  styles.area,
                  { ...draftRect, borderColor: '#ffffff', borderStyle: 'dashed' },
                ]}
              />
            ) : null}
          </Pressable>
        </GestureDetector>
      ) : (
        <Text style={styles.muted}>Loading capture…</Text>
      )}
    </View>
  );
}
