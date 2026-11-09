import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type NativeSessionInfo, viewToggleMapField } from '@farmslot/protocol';
import {
  NATIVE_FOLLOW_LATEST,
  nativeDeliveryLabel,
  nativeFoldWatched,
  type NativeFollow,
  nativeFollowGrew,
  nativeFollowLabel,
  nativeFollowScrolled,
  nativePlanOpen,
  nativeTimeline,
  nativeWatchTools,
} from '@farmslot/protocol/client-cache';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { useViewChoice } from '../../components/view-state';
import {
  type NativeTranscriptItem,
  nativeTranscriptItemKey,
  nativeTranscriptItemType,
  nativeTranscriptList,
} from '../../lib/native-conversation';

import { NativeProfilePicker } from './components/NativeProfilePicker';
import { NativeRequestCard } from './components/NativeRequestCard';
import { NativeSessionSetup } from './components/NativeSessionSetup';
import { NativeSessionState } from './components/NativeSessionState';
import { NativePendingMessageCard, NativeTimelineCard } from './components/NativeTimelineCard';
import { NativeWorkCard } from './components/NativeWorkCard';
import { nativeStyles as styles } from './styles/native-conversation.styles';
import type { useNativeConversationController } from './use-native-conversation-controller';

type Screen = ReturnType<typeof useNativeConversationController>;
export function NativeConversationScreen({
  viewModel: vm,
  actions,
  selected,
  onSelect,
}: Screen & {
  selected: boolean;
  onSelect: (session: NativeSessionInfo) => void;
}) {
  const insets = useSafeAreaInsets();
  const list = useRef<FlashListRef<NativeTranscriptItem>>(null);
  const [follow, setFollow] = useState(NATIVE_FOLLOW_LATEST);
  const viewport = useRef({ offset: 0, height: 0, content: 0 });
  const distanceFromEnd = (contentHeight: number) =>
    contentHeight - viewport.current.offset - viewport.current.height;
  /** The reader opened or closed an entry, so the next size change is theirs, not new output. */
  const disclosed = useRef(false);
  const disclose = useCallback(() => {
    disclosed.current = true;
  }, []);
  /**
   * Set while this screen scrolls to the end itself. The list reaches a far end in steps, and the
   * offsets on the way are not the reader leaving it; their own drag ends this.
   */
  const autoScrolling = useRef(false);
  const scrollToLatest = () => {
    autoScrolling.current = true;
    void list.current?.scrollToEnd({ animated: false });
  };
  const watchedTools = useRef(new Set<number>());
  /** Folds the reader opened or closed, by the key of the entry that ended the turn. */
  const [foldOpen, setFoldOpen] = useViewChoice(viewToggleMapField('folds'));
  const entryCount = useRef(vm.entries.length);
  useEffect(() => {
    entryCount.current = vm.entries.length;
    watchedTools.current = new Set();
    setFollow(NATIVE_FOLLOW_LATEST);
  }, [vm.session?.id]);
  const live = vm.historyObservation.status === 'ready';
  useEffect(() => {
    nativeWatchTools(vm.rows, watchedTools.current, live);
  }, [vm.rows, live]);
  // The view state reads a new object each render; its content is what changes the list.
  const foldChoices = JSON.stringify(foldOpen);
  const pendingCommandId = vm.pendingText !== undefined ? vm.pending?.commandId : undefined;
  const { items, openFolds } = useMemo(() => {
    const folds = new Map(
      vm.rows.flatMap((row) => (row.kind === 'work' ? [[row.key, row] as const] : [])),
    );
    const foldIsOpen = (key: number) => {
      const fold = folds.get(key);
      return foldOpen[String(key)] ?? (fold ? nativeFoldWatched(fold, watchedTools.current) : true);
    };
    return nativeTranscriptList(vm.rows, foldIsOpen, pendingCommandId, vm.requests);
  }, [vm.rows, foldChoices, pendingCommandId, vm.requests]);
  useEffect(() => {
    const added = vm.entries.length - entryCount.current;
    entryCount.current = vm.entries.length;
    setFollow((current) => nativeFollowGrew(current, added));
  }, [vm.entries.length]);
  // Read at press time, so the cells' handlers stay the same objects and memoized cells hold.
  const latest = useRef({ openFolds, setFoldOpen, actions, onSelect });
  latest.current = { openFolds, setFoldOpen, actions, onSelect };
  const toggleFold = useCallback((key: number) => {
    disclosed.current = true;
    const { openFolds, setFoldOpen } = latest.current;
    setFoldOpen((current) => ({ ...current, [key]: !openFolds.has(key) }));
  }, []);
  const implementPlan = useCallback((plan: string) => {
    const { actions, onSelect } = latest.current;
    void actions.resume.implement(plan).then((session) => {
      if (session) onSelect(session);
    });
  }, []);
  const reportFollow = (state: NativeFollow) =>
    latest.current.actions.reportFollow({
      ...state,
      distanceFromEnd: distanceFromEnd(viewport.current.content),
    });
  useEffect(() => reportFollow(follow), [follow]);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    viewport.current = {
      offset: contentOffset.y,
      height: layoutMeasurement.height,
      content: contentSize.height,
    };
    const distance = distanceFromEnd(contentSize.height);
    if (autoScrolling.current) {
      // Following already; only arriving at the end ends the jump.
      if (nativeFollowScrolled(NATIVE_FOLLOW_LATEST, distance).following)
        autoScrolling.current = false;
      reportFollow(follow);
      return;
    }
    const next = nativeFollowScrolled(follow, distance);
    reportFollow(next);
    setFollow((current) => nativeFollowScrolled(current, distance));
  };
  const delivery = nativeDeliveryLabel(vm.receipt);
  const generation = vm.session?.generation;
  const canAnswer = !!vm.session?.capabilities.questions;
  const canApprove = !!vm.session?.capabilities.approvals;
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<NativeTranscriptItem>) => {
      switch (item.kind) {
        case 'work':
          return (
            <NativeWorkCard
              foldKey={item.key}
              label={item.label}
              open={openFolds.has(item.key)}
              onToggle={toggleFold}
            />
          );
        case 'entry': {
          const implement = item.key === vm.implementKey;
          return (
            <NativeTimelineCard
              entry={item.entry}
              onDisclosure={disclose}
              planOpen={nativePlanOpen(item, watchedTools.current)}
              implementing={implement && vm.implementing}
              onImplement={implement ? implementPlan : undefined}
            />
          );
        }
        case 'pending':
          return (
            <NativePendingMessageCard
              // Keyed: a recycled cell never keeps another message's state.
              key={item.commandId}
              text={vm.pendingText ?? ''}
              delivery={delivery}
              onDisclosure={disclose}
              edit={
                vm.canEdit
                  ? {
                      disabled: !vm.writable || vm.busy,
                      onPress: () => void latest.current.actions.edit(),
                    }
                  : undefined
              }
            />
          );
        case 'request':
          return (
            <NativeRequestCard
              // Keyed: its answers in progress belong to this request only.
              key={nativeTranscriptItemKey(item)}
              event={item.event}
              attempted={vm.responses.includes(item.event.request?.id ?? '')}
              disabled={
                !vm.writable ||
                vm.busy ||
                item.event.generation !== generation ||
                (item.event.type === 'question.requested' ? !canAnswer : !canApprove)
              }
              respond={(id, response) => void latest.current.actions.respond(id, response)}
            />
          );
      }
    },
    [
      openFolds,
      vm.implementKey,
      vm.implementing,
      vm.pendingText,
      delivery,
      vm.canEdit,
      vm.writable,
      vm.busy,
      vm.responses,
      generation,
      canAnswer,
      canApprove,
    ],
  );
  const jumpLabel = selected ? nativeFollowLabel(follow) : undefined;
  const [showUnavailable, setShowUnavailable] = useState(false);
  return (
    <KeyboardAvoidingView
      testID="companion-screen-native"
      style={[styles.container, { paddingBottom: insets.bottom }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      <Modal
        transparent
        visible={Boolean(vm.history)}
        animationType="none"
        onRequestClose={actions.dismissSaved}
      >
        <View style={styles.historyShade}>
          <View style={styles.historyDialog}>
            <Pressable
              testID="companion-native-history-close"
              accessibilityRole="button"
              style={styles.button}
              onPress={actions.dismissSaved}
            >
              <Text style={styles.buttonText}>Close saved output</Text>
            </Pressable>
            <Text style={styles.muted}>
              {vm.history?.loading
                ? 'Reading saved page…'
                : vm.history?.error || 'Saved output, read-only'}
            </Text>
            <ScrollView>
              {vm.history?.page
                ? nativeTimeline(vm.history.page.events).map((entry) => (
                    <View key={entry.key} style={styles.card}>
                      <Text style={styles.muted}>{entry.kind}</Text>
                      <Text style={styles.text}>{entry.text}</Text>
                    </View>
                  ))
                : null}
            </ScrollView>
            {vm.history?.page?.hasMore ? (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => void actions.readSaved(vm.history?.page?.cursor)}
              >
                <Text style={styles.buttonText}>Next saved page</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Modal>
      <View style={styles.historyNotice}>
        <Text numberOfLines={1} style={[styles.muted, { flex: 1 }]}>
          {vm.historyNotice}
        </Text>
        {vm.historyNotice ? (
          <Pressable
            testID="companion-native-history-open"
            accessibilityRole="button"
            style={styles.button}
            onPress={() => void actions.readSaved()}
          >
            <Text style={styles.buttonText}>Saved output</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.content}>
        <Text style={styles.heading}>{vm.workerLabel ?? 'Native conversations'}</Text>
        <View style={styles.row}>
          <Text style={styles.muted}>
            {!vm.connected
              ? 'Offline'
              : vm.session
                ? `${vm.session.runner} · ${vm.session.model ?? 'Default model'}`
                : 'Start a conversation or continue an existing one.'}
          </Text>
          {vm.connected && (vm.historyObservation.error || vm.inventoryObservation.error) ? (
            <Pressable
              testID="companion-native-refresh"
              accessibilityRole="button"
              style={styles.button}
              onPress={() => void actions.refresh()}
            >
              <Text style={styles.buttonText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
        {/* Kept while disconnected, with the last state and no clock, so the conversation never moves. */}
        {vm.session ? (
          <NativeSessionState state={vm.session.state} work={vm.connected ? vm.work : undefined} />
        ) : null}
        {selected ? (
          <ResourceReadStatus observation={vm.historyObservation} label="conversation history" />
        ) : null}
        {vm.runObservation ? (
          <ResourceReadStatus observation={vm.runObservation} label="conversation run" />
        ) : null}
        {vm.connected && vm.runObservation?.error ? (
          <Pressable
            testID="companion-native-run-retry"
            accessibilityRole="button"
            style={styles.button}
            onPress={() => void actions.retryRun()}
          >
            <Text style={styles.buttonText}>Retry run</Text>
          </Pressable>
        ) : null}
        {vm.session ? (
          <Text selectable testID="companion-native-identity" style={styles.muted}>
            {vm.session.executionNodeId} · {vm.session.id}
          </Text>
        ) : null}
        {vm.error ? (
          <Text testID="companion-native-error" style={styles.error}>
            {vm.error}
          </Text>
        ) : null}
      </View>
      <View style={styles.timeline}>
        {!selected ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <NativeSessionSetup
              viewModel={vm.creation}
              actions={actions.creation}
              onCreate={(prompt) => {
                void actions.creation.create(prompt).then((session) => {
                  if (session) onSelect(session);
                });
              }}
            />
            {vm.unavailable.length ? (
              <View>
                <Pressable
                  testID="companion-native-unavailable-toggle"
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showUnavailable }}
                  style={styles.button}
                  onPress={() => setShowUnavailable((value) => !value)}
                >
                  <Text style={styles.buttonText}>
                    {showUnavailable ? 'Hide' : 'Show'} unavailable nodes ({vm.unavailable.length})
                  </Text>
                </Pressable>
                {showUnavailable
                  ? vm.unavailable.map((value, index) => (
                      <Text
                        testID={`companion-native-unavailable-detail-${index}`}
                        style={styles.muted}
                        key={value}
                      >
                        {value}
                      </Text>
                    ))
                  : null}
              </View>
            ) : null}
            {vm.sessions.map((session) => (
              <Pressable
                accessibilityRole="button"
                key={`${session.executionNodeId}:${session.id}`}
                testID={`companion-native-session-${session.id}`}
                style={styles.card}
                onPress={() => onSelect(session)}
              >
                <Text style={styles.heading}>
                  {session.runner} · {session.model ?? 'Default model'}
                </Text>
                <Text style={styles.text}>
                  {session.state} · {session.executionNodeId}
                </Text>
                <Text selectable style={styles.muted}>
                  {session.cwd}
                </Text>
                <Text style={styles.muted}>{session.id}</Text>
              </Pressable>
            ))}
            {vm.ready && !vm.sessions.length ? (
              <Text style={styles.muted}>
                No conversations found. Choose a workspace and runner to start one.
              </Text>
            ) : null}
          </ScrollView>
        ) : (
          // FlashList v2 measures its rows itself: no estimated item size.
          <FlashList
            ref={list}
            testID="companion-native-transcript"
            data={items}
            renderItem={renderItem}
            keyExtractor={nativeTranscriptItemKey}
            getItemType={nativeTranscriptItemType}
            ItemSeparatorComponent={NativeTranscriptGap}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              vm.session?.profileId || vm.resume.available ? (
                <View style={styles.listHeader}>
                  {vm.session?.profileId ? (
                    <Text testID="companion-native-session-profile" style={styles.muted}>
                      Configuration: {vm.session.profileId}
                    </Text>
                  ) : null}
                  {vm.resume.available ? (
                    <>
                      <NativeProfilePicker
                        viewModel={vm.resume.profiles}
                        actions={actions.resume.profiles}
                        disabled={vm.resume.busy}
                        locked
                      />
                      <Pressable
                        testID="companion-native-resume"
                        accessibilityRole="button"
                        style={styles.button}
                        accessibilityState={{ disabled: !vm.resume.ready }}
                        disabled={!vm.resume.ready}
                        onPress={() => {
                          void actions.resume.resume().then((session) => {
                            if (session) onSelect(session);
                          });
                        }}
                      >
                        <Text style={styles.buttonText}>
                          {vm.resume.busy ? 'Resuming…' : 'Resume conversation'}
                        </Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              ) : null
            }
            onLayout={(event) => {
              viewport.current.height = event.nativeEvent.layout.height;
            }}
            onScroll={onScroll}
            onScrollBeginDrag={() => {
              autoScrolling.current = false;
            }}
            scrollEventThrottle={100}
            onContentSizeChange={(_, height) => {
              viewport.current.content = height;
              // Content can grow with no scroll event: the proof reads the distance it left.
              reportFollow(follow);
              if (disclosed.current) {
                // Keep the reader's place; follow again only if the end is still in view.
                disclosed.current = false;
                const distance = distanceFromEnd(height);
                setFollow((current) => nativeFollowScrolled(current, distance));
              } else if (follow.following) {
                scrollToLatest();
              }
            }}
          />
        )}
        {jumpLabel ? (
          <Pressable
            testID="companion-native-jump-latest"
            accessibilityRole="button"
            style={styles.jumpLatest}
            onPress={() => {
              setFollow(NATIVE_FOLLOW_LATEST);
              // Instant, like Command Center: an animated scroll reports positions short of the end.
              scrollToLatest();
            }}
          >
            <Text style={styles.buttonText}>{jumpLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      {selected ? (
        <View style={styles.composer}>
          {/* Offline, the heading already says so. */}
          {!vm.writable && vm.connected ? (
            <Text testID="companion-native-read-only" style={styles.muted}>
              Read-only: no live input owner
            </Text>
          ) : null}
          <TextInput
            testID="companion-native-draft"
            accessibilityLabel="Message to agent"
            multiline
            placeholder="Message to agent"
            placeholderTextColor="#888"
            style={styles.input}
            editable={vm.writable && !vm.busy && !vm.pending}
            value={vm.draft}
            onChangeText={actions.setDraft}
            onBlur={() => void actions.saveDraft()}
          />
          {vm.pending ? (
            <View style={styles.row}>
              <Text testID="companion-native-delivery" style={styles.muted}>
                {nativeDeliveryLabel(vm.receipt)}
              </Text>
              {vm.canRetry ? (
                <Pressable
                  testID="companion-native-retry"
                  accessibilityRole="button"
                  disabled={!vm.writable || vm.busy}
                  style={styles.button}
                  onPress={() => void actions.retry()}
                >
                  <Text style={styles.buttonText}>Retry same message</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <View style={styles.row}>
            <Pressable
              testID="companion-native-send"
              accessibilityRole="button"
              disabled={!vm.canSend}
              style={[styles.button, !vm.canSend && styles.disabled]}
              onPress={() => void actions.send()}
            >
              <Text style={styles.buttonText}>{vm.sendLabel}</Text>
            </Pressable>
            {vm.steerable ? (
              <Pressable
                testID="companion-native-steer"
                accessibilityRole="button"
                accessibilityHint="Adds this message to the running turn"
                disabled={!vm.canSteer}
                style={[styles.button, !vm.canSteer && styles.disabled]}
                onPress={() => void actions.send('steer')}
              >
                <Text style={styles.buttonText}>Steer</Text>
              </Pressable>
            ) : null}
            <Pressable
              testID="companion-native-stop"
              accessibilityRole="button"
              disabled={!vm.canStop}
              style={[styles.button, !vm.canStop && styles.disabled]}
              onPress={() => void actions.stop()}
            >
              <Text style={styles.buttonText}>Stop turn</Text>
            </Pressable>
            {vm.session && !vm.session.capabilities.interrupt ? (
              <Text style={styles.muted}>Interruption unavailable for this session.</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

/** The space between conversation cells: the list has no gap of its own. */
function NativeTranscriptGap() {
  return <View style={styles.gap} />;
}
