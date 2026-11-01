import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NativeSessionInfo } from '@farmslot/protocol';
import {
  NATIVE_FOLLOW_LATEST,
  nativeDeliveryLabel,
  nativeFoldWatched,
  nativeFollowGrew,
  nativeFollowLabel,
  nativeFollowScrolled,
  nativePlanOpen,
  nativeWatchTools,
} from '@farmslot/protocol/client-cache';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';

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
  const scroll = useRef<ScrollView>(null);
  const [follow, setFollow] = useState(NATIVE_FOLLOW_LATEST);
  const viewport = useRef({ offset: 0, height: 0 });
  const distanceFromEnd = (contentHeight: number) =>
    contentHeight - viewport.current.offset - viewport.current.height;
  /** The reader opened or closed an entry, so the next size change is theirs, not new output. */
  const disclosed = useRef(false);
  const disclose = () => {
    disclosed.current = true;
  };
  const watchedTools = useRef(new Set<number>());
  /** Folds the reader opened or closed, by the key of the entry that ended the turn. */
  const [foldOpen, setFoldOpen] = useState(new Map<number, boolean>());
  const entryCount = useRef(vm.entries.length);
  useEffect(() => {
    entryCount.current = vm.entries.length;
    watchedTools.current = new Set();
    setFoldOpen(new Map());
    setFollow(NATIVE_FOLLOW_LATEST);
  }, [vm.session?.id]);
  const live = vm.historyObservation.status === 'ready';
  useEffect(() => {
    nativeWatchTools(vm.rows, watchedTools.current, live);
  }, [vm.rows, live]);
  const folds = new Map(
    vm.rows.flatMap((row) => (row.kind === 'work' ? [[row.key, row] as const] : [])),
  );
  const foldIsOpen = (key: number) => {
    const fold = folds.get(key);
    return foldOpen.get(key) ?? (fold ? nativeFoldWatched(fold, watchedTools.current) : true);
  };
  useEffect(() => {
    const added = vm.entries.length - entryCount.current;
    entryCount.current = vm.entries.length;
    setFollow((current) => nativeFollowGrew(current, added));
  }, [vm.entries.length]);
  const jumpLabel = selected ? nativeFollowLabel(follow) : undefined;
  const [showUnavailable, setShowUnavailable] = useState(false);
  return (
    <KeyboardAvoidingView
      testID="companion-screen-native"
      style={[styles.container, { paddingBottom: insets.bottom }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
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
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          onLayout={(event) => {
            viewport.current.height = event.nativeEvent.layout.height;
          }}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            viewport.current = { offset: contentOffset.y, height: layoutMeasurement.height };
            const distance = distanceFromEnd(contentSize.height);
            setFollow((current) => nativeFollowScrolled(current, distance));
          }}
          scrollEventThrottle={100}
          onContentSizeChange={(_, height) => {
            if (disclosed.current) {
              // Keep the reader's place; follow again only if the end is still in view.
              disclosed.current = false;
              const distance = distanceFromEnd(height);
              setFollow((current) => nativeFollowScrolled(current, distance));
            } else if (follow.following && selected) {
              scroll.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          {!selected ? (
            <>
              <NativeSessionSetup
                viewModel={vm.creation}
                actions={actions.creation}
                onCreate={() => {
                  void actions.creation.create().then((session) => {
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
                      {showUnavailable ? 'Hide' : 'Show'} unavailable nodes ({vm.unavailable.length}
                      )
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
            </>
          ) : (
            <>
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
              {vm.rows.map((row) =>
                row.kind === 'work' ? (
                  <NativeWorkCard
                    key={`work:${row.key}`}
                    label={row.label}
                    open={foldIsOpen(row.key)}
                    onToggle={() => {
                      disclose();
                      setFoldOpen(new Map(foldOpen).set(row.key, !foldIsOpen(row.key)));
                    }}
                  />
                ) : (
                  <NativeTimelineCard
                    key={row.key}
                    entry={row.entry}
                    onDisclosure={disclose}
                    hidden={row.fold !== undefined && !foldIsOpen(row.fold)}
                    planOpen={nativePlanOpen(row, watchedTools.current)}
                    implementing={vm.implementing}
                    onImplement={
                      // A proposal's entry text is its plan.
                      row.key === vm.implementKey
                        ? () =>
                            void actions.resume.implement(row.entry.text).then((session) => {
                              if (session) onSelect(session);
                            })
                        : undefined
                    }
                  />
                ),
              )}
              {vm.pendingText !== undefined ? (
                <NativePendingMessageCard
                  key={vm.pending?.commandId}
                  text={vm.pendingText}
                  delivery={nativeDeliveryLabel(vm.receipt)}
                  onDisclosure={disclose}
                  edit={
                    vm.canEdit
                      ? { disabled: !vm.writable || vm.busy, onPress: () => void actions.edit() }
                      : undefined
                  }
                />
              ) : null}
              {vm.requests.map((request) => (
                <NativeRequestCard
                  key={`${request.generation}:${request.request?.id}`}
                  event={request}
                  attempted={vm.responses.includes(request.request?.id ?? '')}
                  disabled={
                    !vm.writable ||
                    vm.busy ||
                    request.generation !== vm.session?.generation ||
                    (request.type === 'question.requested'
                      ? !vm.session?.capabilities.questions
                      : !vm.session?.capabilities.approvals)
                  }
                  respond={(id, response) => void actions.respond(id, response)}
                />
              ))}
            </>
          )}
        </ScrollView>
        {jumpLabel ? (
          <Pressable
            testID="companion-native-jump-latest"
            accessibilityRole="button"
            style={styles.jumpLatest}
            onPress={() => {
              setFollow(NATIVE_FOLLOW_LATEST);
              // Instant, like Command Center: an animated scroll reports positions short of the end.
              scroll.current?.scrollToEnd({ animated: false });
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
