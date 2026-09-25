import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { colors } from '../../lib/theme';
import { visualReviewSurfaceLinks } from '../../lib/visual-review';

import { AnnotationCanvas } from './components/AnnotationCanvas';
import { AnnotationInspector } from './components/AnnotationInspector';
import { FeedbackDelivery } from './components/FeedbackDelivery';
import { SurfaceNavigator } from './components/SurfaceNavigator';
import { visualReviewStyles as styles } from './styles/visual-review.styles';
import { useVisualReviewController } from './use-visual-review-controller';
import {
  visualReviewCaptureKey,
  type VisualReviewReadyState,
  type VisualReviewRouteParams,
} from './visual-review-controller';

export function VisualReviewScreen({ route }: { route: VisualReviewRouteParams }) {
  const { state, exportMessage, actions } = useVisualReviewController(route);

  if (state.status === 'loading') {
    return (
      <View style={[styles.screen, styles.centered]} testID="companion-screen-visual-review">
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.muted}>Loading visual review source…</Text>
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View style={[styles.screen, styles.centered]} testID="companion-screen-visual-review">
        <Text style={styles.error} testID="visual-review-error">
          {state.message}
        </Text>
        <Pressable style={styles.button} onPress={actions.retry}>
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  return <ReadyVisualReview state={state} exportMessage={exportMessage} actions={actions} />;
}

function ReadyVisualReview({
  state,
  exportMessage,
  actions,
}: {
  state: VisualReviewReadyState;
  exportMessage: string | null;
  actions: ReturnType<typeof useVisualReviewController>['actions'];
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [fullWidth, setFullWidth] = useState(false);
  const { source, draft, surfaceId, captureId } = state;
  const links = useMemo(() => visualReviewSurfaceLinks(source, surfaceId), [source, surfaceId]);
  const feedbackCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [id, body] of Object.entries(draft.surfaceNotes)) {
      if (body.trim()) counts[id] = (counts[id] ?? 0) + 1;
    }
    for (const annotation of draft.annotations) {
      if (annotation.body.trim())
        counts[annotation.surfaceId] = (counts[annotation.surfaceId] ?? 0) + 1;
    }
    return counts;
  }, [draft]);
  const capture = state.captures[visualReviewCaptureKey(surfaceId, captureId)];
  const captureAnnotations = draft.annotations.filter(
    (annotation) => annotation.surfaceId === surfaceId && annotation.captureId === captureId,
  );
  const noteCount = Object.values(draft.surfaceNotes).filter((body) => body.trim()).length;

  return (
    <ScrollView
      ref={scrollRef}
      testID="companion-screen-visual-review"
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 4 }}>
        <Text style={styles.eyebrow}>Visual review · run {state.targetRunId}</Text>
        <Text style={styles.body}>{source.title}</Text>
        <Text style={styles.muted}>
          Captured {source.capturedAt} · {source.id}
        </Text>
      </View>
      <SurfaceNavigator
        source={source}
        links={links}
        feedbackCounts={feedbackCounts}
        onSelect={actions.selectSurface}
      />
      <View style={styles.row}>
        {(['point', 'area'] as const).map((mode) => (
          <Pressable
            key={mode}
            testID={`visual-review-mode-${mode}`}
            accessibilityRole="button"
            accessibilityState={{ selected: state.mode === mode }}
            style={[styles.chip, state.mode === mode && styles.chipActive]}
            onPress={() => actions.setMode(mode)}
          >
            <Text style={styles.chipText}>{mode === 'point' ? 'Tap a point' : 'Drag an area'}</Text>
          </Pressable>
        ))}
        <Pressable
          testID="visual-review-full-width"
          accessibilityRole="button"
          accessibilityState={{ selected: fullWidth }}
          style={[styles.chip, fullWidth && styles.chipActive]}
          onPress={() => setFullWidth((value) => !value)}
        >
          <Text style={styles.chipText}>Full width</Text>
        </Pressable>
        {links.surface.captures.length > 1
          ? links.surface.captures.map((candidate) => (
              <Pressable
                key={candidate.id}
                testID={`visual-review-capture-${candidate.id}`}
                style={[styles.chip, candidate.id === captureId && styles.chipActive]}
                onPress={() => actions.selectCapture(candidate.id)}
              >
                <Text style={styles.chipText}>{candidate.platform}</Text>
              </Pressable>
            ))
          : null}
      </View>
      {capture ? (
        <AnnotationCanvas
          key={visualReviewCaptureKey(surfaceId, captureId)}
          capture={capture}
          annotations={captureAnnotations}
          selectedAnnotationId={state.selectedAnnotationId}
          mode={state.mode}
          fullWidth={fullWidth}
          scrollRef={scrollRef}
          onAdd={actions.addAnnotation}
          onSelect={actions.selectAnnotation}
          onMove={actions.moveAnnotation}
        />
      ) : (
        <Text style={styles.muted}>This surface has no capture.</Text>
      )}
      <AnnotationInspector
        annotations={captureAnnotations}
        selectedAnnotationId={state.selectedAnnotationId}
        onSelect={actions.selectAnnotation}
        onUpdate={actions.updateAnnotation}
        onMove={actions.moveAnnotation}
        onRemove={actions.removeAnnotation}
      />
      <View style={styles.card}>
        <Text style={styles.eyebrow}>Overall note for {links.surface.title}</Text>
        <TextInput
          testID="visual-review-surface-note"
          style={styles.input}
          multiline
          placeholder="Feedback that applies to the whole screen…"
          placeholderTextColor={colors.textMuted}
          value={draft.surfaceNotes[surfaceId] ?? ''}
          onChangeText={actions.setSurfaceNote}
        />
      </View>
      <FeedbackDelivery
        delivery={state.delivery}
        targetRunId={state.targetRunId}
        noteCount={noteCount}
        annotationCount={draft.annotations.filter((annotation) => annotation.body.trim()).length}
        exportMessage={exportMessage}
        onExport={actions.exportFeedback}
        onSend={actions.submit}
      />
    </ScrollView>
  );
}
