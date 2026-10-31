import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { NativeSessionPlan } from '@farmslot/protocol';
import {
  nativeCommandText,
  nativeEntryPreview,
  type NativeMessagePreview,
  nativeMessagePreview,
  nativeMessageToggleLabel,
  type NativeTimelineEntry,
} from '@farmslot/protocol/client-cache';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

const PLAN_STEP_MARK = { pending: '○', 'in-progress': '▸', completed: '✓' } as const;

export function NativeTimelineCard({
  entry,
  onDisclosure,
  hidden = false,
  planOpen = true,
}: {
  entry: NativeTimelineEntry;
  /** Called before the card opens or closes, so the conversation keeps the reader's place. */
  onDisclosure: () => void;
  /** Inside a closed fold: kept mounted, so its own state survives. */
  hidden?: boolean;
  /** A checklist starts showing its steps (`nativePlanOpen`). */
  planOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(entry.kind === 'plan' && planOpen);
  const [raw, setRaw] = useState(false);
  const toggle = () => {
    onDisclosure();
    setExpanded(!expanded);
  };
  const preview = nativeEntryPreview(entry);
  const command = nativeCommandText(entry.event.tool);
  const plan = entry.event.plan;
  return (
    <View style={[styles.card, entry.kind === 'user' && styles.user, hidden && styles.hidden]}>
      <Text style={styles.muted}>
        {entry.kind === 'user'
          ? 'You'
          : entry.kind === 'assistant'
            ? 'Assistant'
            : entry.kind === 'tool'
              ? 'Tool'
              : entry.kind === 'resolution'
                ? 'Request'
                : plan?.kind === 'proposal'
                  ? 'Proposed plan'
                  : plan
                    ? 'Plan'
                    : 'Status'}
      </Text>
      {plan ? (
        <NativePlanBody
          plan={plan}
          text={entry.text}
          preview={preview}
          open={expanded}
          onToggle={toggle}
          onDisclosure={onDisclosure}
        />
      ) : entry.kind === 'tool' ? (
        <>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggle}>
            <Text style={styles.buttonText}>
              {entry.text} ·{' '}
              {entry.event.tool?.status ??
                (entry.event.type === 'tool.completed' ? 'completed' : 'running')}{' '}
              · {expanded ? 'Hide' : 'Details'}
            </Text>
          </Pressable>
          {expanded && command ? (
            <>
              <Text selectable style={styles.code}>
                {command}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: raw }}
                style={styles.messageToggle}
                onPress={() => {
                  onDisclosure();
                  setRaw(!raw);
                }}
              >
                <Text style={styles.buttonText}>
                  {raw ? 'Hide raw input and output' : 'Raw input and output'}
                </Text>
              </Pressable>
            </>
          ) : null}
          {expanded && (!command || raw) ? (
            <ScrollView nestedScrollEnabled style={styles.detail}>
              <Text selectable style={styles.code}>
                {JSON.stringify(entry.event.tool, null, 2)}
              </Text>
            </ScrollView>
          ) : null}
        </>
      ) : (
        <NativeMessageText
          text={entry.text}
          preview={preview}
          muted={entry.kind === 'status'}
          onDisclosure={onDisclosure}
        />
      )}
    </View>
  );
}

/** A checklist's progress and steps, or a proposed plan with a copy action. */
function NativePlanBody({
  plan,
  text,
  preview,
  open,
  onToggle,
  onDisclosure,
}: {
  plan: NativeSessionPlan;
  text: string;
  preview?: NativeMessagePreview;
  open: boolean;
  onToggle: () => void;
  onDisclosure: () => void;
}) {
  const [copied, setCopied] = useState<boolean>();
  if (plan.kind === 'proposal')
    return (
      <>
        <NativeMessageText text={text} preview={preview} onDisclosure={onDisclosure} />
        <Pressable
          testID="companion-native-plan-copy"
          accessibilityRole="button"
          style={styles.messageToggle}
          onPress={() =>
            Clipboard.setStringAsync(plan.text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          <Text style={styles.buttonText}>
            {copied === undefined ? 'Copy plan' : copied ? 'Copied' : 'Copy failed'}
          </Text>
        </Pressable>
      </>
    );
  return (
    <>
      <Pressable
        testID="companion-native-plan-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.messageToggle}
        onPress={onToggle}
      >
        <Text style={styles.buttonText}>
          {text} · {open ? 'Hide' : 'Steps'}
        </Text>
      </Pressable>
      {open ? (
        <>
          {plan.text ? <Text style={styles.text}>{plan.text}</Text> : null}
          {plan.steps.map((step, index) => (
            <Text
              key={`${index}:${step.text}`}
              selectable
              style={step.status === 'completed' ? styles.muted : styles.text}
            >
              {PLAN_STEP_MARK[step.status]} {step.text}
            </Text>
          ))}
        </>
      ) : null}
    </>
  );
}

/** A message sent from here that the conversation does not show yet, with its delivery state. */
export function NativePendingMessageCard({
  text,
  delivery,
  onDisclosure,
  edit,
}: {
  text: string;
  delivery: string;
  onDisclosure: () => void;
  /** A queued message the host can still remove: Edit takes it back into the composer. */
  edit?: { disabled: boolean; onPress: () => void };
}) {
  return (
    <View testID="companion-native-pending-message" style={[styles.card, styles.user]}>
      <Text style={styles.muted}>You · {delivery}</Text>
      <NativeMessageText
        text={text}
        preview={nativeMessagePreview(text)}
        onDisclosure={onDisclosure}
      />
      {edit ? (
        <Pressable
          testID="companion-native-edit"
          accessibilityRole="button"
          accessibilityState={{ disabled: edit.disabled }}
          disabled={edit.disabled}
          style={[styles.messageToggle, edit.disabled && styles.disabled]}
          onPress={edit.onPress}
        >
          <Text style={styles.buttonText}>Edit</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function NativeMessageText({
  text,
  preview,
  muted = false,
  onDisclosure,
}: {
  text: string;
  preview?: NativeMessagePreview;
  muted?: boolean;
  onDisclosure: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <Text selectable style={muted ? styles.muted : styles.text}>
        {preview && !expanded ? preview.text : text}
      </Text>
      {preview ? (
        <Pressable
          testID="companion-native-message-toggle"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          style={styles.messageToggle}
          onPress={() => {
            onDisclosure();
            setExpanded(!expanded);
          }}
        >
          <Text style={styles.buttonText}>{nativeMessageToggleLabel(preview, expanded)}</Text>
        </Pressable>
      ) : null}
    </>
  );
}
