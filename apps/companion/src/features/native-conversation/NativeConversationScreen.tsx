import { useRef, useState } from 'react';
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

import { nativeDeliveryLabel } from '../../lib/native-conversation';

import { NativeProfilePicker } from './components/NativeProfilePicker';
import { NativeRequestCard } from './components/NativeRequestCard';
import { NativeSessionSetup } from './components/NativeSessionSetup';
import { NativeTimelineCard } from './components/NativeTimelineCard';
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
  const follow = useRef(true);
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
              ? 'Gateway disconnected'
              : vm.session
                ? `${vm.session.runner} · ${vm.session.model ?? 'Default model'} · ${vm.session.state}`
                : 'Start a conversation or continue an existing one.'}
          </Text>
          <Pressable
            testID="companion-native-refresh"
            accessibilityRole="button"
            style={styles.button}
            onPress={() => void actions.refresh()}
          >
            <Text style={styles.buttonText}>Refresh</Text>
          </Pressable>
        </View>
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
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          follow.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (follow.current && selected) scroll.current?.scrollToEnd({ animated: false });
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
            {vm.entries.map((entry) => (
              <NativeTimelineCard key={entry.key} entry={entry} />
            ))}
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
      {selected ? (
        <View style={styles.composer}>
          {!vm.writable ? (
            <Text testID="companion-native-read-only" style={styles.muted}>
              {!vm.connected
                ? 'Reconnect to continue.'
                : 'Read-only until this conversation has a live, current input owner.'}
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
              {!vm.receipt || ['pending', 'unknown'].includes(vm.receipt.state) ? (
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
              <Text style={styles.buttonText}>Send</Text>
            </Pressable>
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
