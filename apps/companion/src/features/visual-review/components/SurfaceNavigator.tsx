import { Pressable, Text, View } from 'react-native';

import type { VisualReviewSourceDocument, VisualReviewSurface } from '@farmslot/protocol';

import type { VisualReviewSurfaceLinks } from '../../../lib/visual-review';
import { visualReviewStyles as styles } from '../styles/visual-review.styles';

function SurfaceChip({
  surface,
  testID,
  active,
  feedbackCount,
  onPress,
}: {
  surface: VisualReviewSurface;
  testID: string;
  active?: boolean;
  feedbackCount: number;
  onPress: (surfaceId: string) => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(active) }}
      accessibilityLabel={`Open ${surface.title}`}
      style={[styles.chip, active && styles.chipActive]}
      onPress={() => onPress(surface.id)}
    >
      <Text style={styles.chipText}>{surface.title}</Text>
      {feedbackCount > 0 ? <Text style={styles.chipCount}>{feedbackCount}</Text> : null}
    </Pressable>
  );
}

function LinkRow({
  label,
  surfaces,
  prefix,
  feedbackCounts,
  onSelect,
}: {
  label: string;
  surfaces: VisualReviewSurface[];
  prefix: string;
  feedbackCounts: Record<string, number>;
  onSelect: (surfaceId: string) => void;
}) {
  if (surfaces.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.eyebrow}>{label}</Text>
      <View style={styles.row}>
        {surfaces.map((surface) => (
          <SurfaceChip
            key={surface.id}
            surface={surface}
            testID={`visual-review-${prefix}-${surface.id}`}
            feedbackCount={feedbackCounts[surface.id] ?? 0}
            onPress={onSelect}
          />
        ))}
      </View>
    </View>
  );
}

/** Touch navigator: hierarchy first, then related and incoming navigation context. */
export function SurfaceNavigator({
  source,
  links,
  feedbackCounts,
  onSelect,
}: {
  source: VisualReviewSourceDocument;
  links: VisualReviewSurfaceLinks;
  feedbackCounts: Record<string, number>;
  onSelect: (surfaceId: string) => void;
}) {
  const parent = links.ancestors[links.ancestors.length - 1];
  return (
    <View style={styles.card} testID="visual-review-navigator">
      <Text style={styles.eyebrow}>
        {[...links.ancestors.map((surface) => surface.title), 'This screen'].join(' › ')}
      </Text>
      <Text style={styles.title} testID="visual-review-current-surface">
        {links.surface.title}
      </Text>
      {links.incoming.length > 0 ? (
        <Text style={styles.muted}>
          Reached by{' '}
          {links.incoming.map(({ from, kind }) => `${kind} from ${from.title}`).join(', ')}
        </Text>
      ) : null}
      <LinkRow
        label="Parent"
        surfaces={parent ? [parent] : []}
        prefix="parent"
        feedbackCounts={feedbackCounts}
        onSelect={onSelect}
      />
      <LinkRow
        label="Subscreens"
        surfaces={links.children}
        prefix="child"
        feedbackCounts={feedbackCounts}
        onSelect={onSelect}
      />
      <LinkRow
        label="Related"
        surfaces={links.related}
        prefix="related"
        feedbackCounts={feedbackCounts}
        onSelect={onSelect}
      />
      <View style={{ gap: 6 }}>
        <Text style={styles.eyebrow}>All surfaces · {source.surfaces.length}</Text>
        <View style={styles.row}>
          {source.surfaces.map((surface) => (
            <SurfaceChip
              key={surface.id}
              surface={surface}
              testID={`visual-review-surface-${surface.id}`}
              active={surface.id === links.surface.id}
              feedbackCount={feedbackCounts[surface.id] ?? 0}
              onPress={onSelect}
            />
          ))}
        </View>
      </View>
    </View>
  );
}
