import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  ROADMAP_DELIVERY_FILTERS,
  ROADMAP_ITEM_STAGES,
  type RoadmapDeliverySummary,
  type RoadmapItem,
} from '@farmslot/protocol';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { colors, floatingCopilotGutter, fonts, radii, spacing } from '../../lib/theme';

import type { StageFilter, useRoadmapController } from './use-roadmap-controller';

type RoadmapScreenModel = ReturnType<typeof useRoadmapController>;

export default function RoadmapScreen({ screen }: { screen: RoadmapScreenModel }) {
  const { actions, state } = screen;
  const renderCard = (item: RoadmapItem) => {
    const summary = state.delivery.find((entry) => entry.roadmapItemId === item.id);
    return (
      <Pressable key={item.id} style={styles.card} onPress={() => actions.openItem(item.id)}>
        <View style={styles.metaRow}>
          <Text style={styles.stage}>{item.stage}</Text>
          <Text style={styles.project}>{item.project}</Text>
          {summary ? (
            <Text style={[styles.delivery, deliveryStyle(summary.status)]}>{summary.status}</Text>
          ) : null}
        </View>
        <Text style={styles.ref}>{item.id}</Text>
        <Text style={styles.itemTitle} numberOfLines={3}>
          {item.title}
        </Text>
        {state.deliveredDetails
          .find((entry) => entry.roadmapItemId === item.id)
          ?.prs.map((pr) => (
            <Pressable
              key={pr.ref}
              disabled={!pr.url}
              onPress={() => pr.url && void actions.openPr(pr.url)}
            >
              <Text style={styles.stage}>{pr.ref}</Text>
            </Pressable>
          ))}
        <View style={styles.footer}>
          <Text style={styles.muted}>{item.promotion?.length ?? 0} backlog links</Text>
          {summary ? (
            <Text style={styles.muted}>
              {summary.runFamilyCount} runs · {summary.prCount} PRs
            </Text>
          ) : null}
          <Ionicons name="chevron-forward" size={17} color={colors.textMuted} />
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View>
          <Text style={styles.title}>Roadmap</Text>
          <Text style={styles.count}>{state.deliveryView.items.length} planning items</Text>
        </View>
        <Ionicons name="map-outline" size={23} color={colors.accent} style={styles.toolbarIcon} />
      </View>
      <View style={styles.filters}>
        <TextInput
          style={styles.search}
          value={state.search}
          onChangeText={actions.setSearch}
          placeholder="Search roadmap"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={['all', ...ROADMAP_ITEM_STAGES] as StageFilter[]}
          keyExtractor={(entry) => entry}
          contentContainerStyle={styles.stageList}
          renderItem={({ item: option }) => (
            <Pressable
              style={[styles.stageChip, state.stage === option && styles.stageChipSelected]}
              onPress={() => actions.setStage(option)}
            >
              <Text style={[styles.stageText, state.stage === option && styles.stageTextSelected]}>
                {option}
              </Text>
            </Pressable>
          )}
        />
        <View style={styles.metaRow}>
          {ROADMAP_DELIVERY_FILTERS.map((option) => (
            <Pressable
              key={option}
              style={[
                styles.stageChip,
                state.deliveryFilter === option && styles.stageChipSelected,
              ]}
              onPress={() => actions.setDeliveryFilter(option)}
            >
              <Text
                style={[
                  styles.stageText,
                  state.deliveryFilter === option && styles.stageTextSelected,
                ]}
              >
                {option === 'all' ? 'All outcomes' : option}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <ResourceReadStatus
        observation={state.observation}
        label="roadmap"
        onRetry={() => void actions.refresh()}
        retryDisabled={!state.connected}
      />
      <FlatList
        data={state.deliveryView.undelivered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: state.bottomPadding }]}
        ListEmptyComponent={
          state.loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : state.deliveryView.items.length === 0 ? (
            <Text style={styles.empty}>No roadmap items in this scope.</Text>
          ) : undefined
        }
        renderItem={({ item }) => renderCard(item)}
        ListFooterComponent={
          state.deliveryFilter !== 'undelivered' ? (
            <View style={styles.deliveredGroup}>
              <Pressable
                onPress={() => actions.setDeliveredExpanded(!state.deliveredExpanded)}
                style={styles.metaRow}
              >
                <Ionicons
                  name={state.deliveredExpanded ? 'chevron-down' : 'chevron-forward'}
                  size={17}
                  color={colors.textMuted}
                />
                <Text style={styles.itemTitle}>
                  Delivered ({state.deliveryView.delivered.length})
                </Text>
              </Pressable>
              {state.deliveredExpanded ? (
                <>
                  {state.deliveredLoading ? <ActivityIndicator color={colors.accent} /> : null}
                  {state.deliveredError ? (
                    <Text style={styles.error}>{state.deliveredError}</Text>
                  ) : null}
                  {state.deliveryView.delivered.map(renderCard)}
                </>
              ) : null}
            </View>
          ) : undefined
        }
      />
    </View>
  );
}

function deliveryStyle(status: RoadmapDeliverySummary['status']) {
  if (status === 'delivered') return { color: colors.statusOk };
  if (status === 'inconsistent') return { color: colors.statusFail };
  if (status === 'active' || status === 'partial') return { color: colors.statusWarn };
  return { color: colors.textMuted };
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgBase, flex: 1 },
  toolbar: {
    alignItems: 'center',
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  toolbarIcon: { marginRight: floatingCopilotGutter },
  title: { color: colors.textPrimary, fontSize: fonts.sizeXl, fontWeight: '900' },
  count: { color: colors.textMuted, fontSize: fonts.sizeXs, marginTop: spacing.xs },
  filters: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.sm },
  search: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    minHeight: 42,
    paddingHorizontal: spacing.lg,
  },
  stageList: { gap: spacing.sm },
  stageChip: {
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  stageChipSelected: { backgroundColor: colors.accent + '20', borderColor: colors.accent },
  stageText: { color: colors.textMuted, fontSize: fonts.sizeXs },
  stageTextSelected: { color: colors.accent, fontWeight: '900' },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm, paddingHorizontal: spacing.lg },
  list: { gap: spacing.md, padding: spacing.lg },
  empty: { color: colors.textMuted, fontSize: fonts.sizeSm, paddingVertical: spacing.xl },
  deliveredGroup: { gap: spacing.md, paddingVertical: spacing.md },
  card: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  stage: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  project: { color: colors.textMuted, flex: 1, fontSize: fonts.sizeXs },
  delivery: { fontFamily: fonts.mono, fontSize: fonts.sizeXs, fontWeight: '900' },
  ref: { color: colors.textMuted, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  itemTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
    lineHeight: 20,
  },
  footer: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  muted: { color: colors.textMuted, flex: 1, fontSize: fonts.sizeXs },
});
