import { memo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  type NativeSessionPlan,
  type NativeSessionTool,
  viewToggleField,
} from '@farmslot/protocol';
import {
  nativeCommandText,
  nativeEntryPreview,
  type NativeMessagePreview,
  nativeMessagePreview,
  nativeMessageToggleLabel,
  nativePlanStepMark,
  type NativeTimelineEntry,
  nativeToolDiffText,
  nativeToolDisclosureKey,
} from '@farmslot/protocol/client-cache';

import { FormattedDocument } from '../../../components/FormattedDocument';
import { MobileDiffViewer } from '../../../components/MobileDiffViewer';
import { useViewChoice, useViewToggle } from '../../../components/view-state';
import { formatDocumentCached } from '../../../lib/document-format-cache';
import { nativeStyles as styles } from '../styles/native-conversation.styles';

import { NativeCopyButton, NativeLinkedText } from './NativeMessageActions';

interface NativeTimelineCardProps {
  entry: NativeTimelineEntry;
  /** Called before the card opens or closes, so the conversation keeps the reader's place. */
  onDisclosure: () => void;
  /** A checklist starts showing its steps (`nativePlanOpen`). */
  planOpen?: boolean;
  /** On the proposal Implement is offered on (`nativeImplementableKey`); gets the plan text. */
  onImplement?: (plan: string) => void;
  /** Implement is starting its session. */
  implementing?: boolean;
}

/**
 * Memoized on its props, all identities or flags: an unchanged entry (`nativeTimeline` keeps it
 * the same object) with the same flags skips rendering while others stream in or the reader types.
 */
export const NativeTimelineCard = memo(function NativeTimelineCard({
  entry,
  onDisclosure,
  planOpen = true,
  onImplement,
  implementing = false,
}: NativeTimelineCardProps) {
  const [expanded, setExpanded] = useViewChoice(
    entry.kind === 'tool'
      ? viewToggleField('messages', nativeToolDisclosureKey(entry.key), false)
      : viewToggleField('panels', `native-entry:${entry.key}`, entry.kind === 'plan' && planOpen),
  );
  const [raw, setRaw] = useViewToggle(`native-raw:${entry.key}`);
  const toggle = () => {
    onDisclosure();
    setExpanded(!expanded);
  };
  const preview = nativeEntryPreview(entry);
  const command = nativeCommandText(entry.event.tool);
  const plan = entry.event.plan;
  return (
    <View style={[styles.card, entry.kind === 'user' && styles.user]}>
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
          // A recycled list cell gets another entry: its copy state starts over.
          key={entry.key}
          choiceId={String(entry.key)}
          plan={plan}
          text={entry.text}
          preview={preview}
          open={expanded}
          onToggle={toggle}
          onDisclosure={onDisclosure}
          // A proposal's entry text is its plan.
          onImplement={onImplement ? () => onImplement(entry.text) : undefined}
          implementing={implementing}
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
              <NativeCopyButton
                text={command}
                action="Copy command"
                testID="companion-native-copy-command"
              />
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
          {expanded
            ? entry.event.tool?.diffs?.map((diff, index) => (
                <MobileDiffViewer
                  // Keyed by entry too: a recycled list cell must not keep another tool's diff state.
                  key={`${entry.key}:${diff.path}:${index}`}
                  title={diff.path}
                  diffText={nativeToolDiffText(diff)}
                  initialPath={diff.path}
                  fullscreenChoiceId={`native-diff:${entry.key}:${diff.path}:${index}`}
                />
              ))
            : null}
          {expanded && (!command || raw) ? <NativeToolRaw tool={entry.event.tool} /> : null}
        </>
      ) : (
        <>
          <NativeMessageText
            choiceId={String(entry.key)}
            text={entry.text}
            preview={preview}
            muted={entry.kind === 'status'}
            onDisclosure={onDisclosure}
          />
          <NativeCopyButton text={entry.text} />
        </>
      )}
    </View>
  );
});

/** A tool's raw input and output, with a copy of the same JSON. */
function NativeToolRaw({ tool }: { tool?: NativeSessionTool }) {
  const json = JSON.stringify(tool, null, 2);
  return (
    <>
      <ScrollView nestedScrollEnabled style={styles.detail}>
        <Text selectable style={styles.code}>
          {json}
        </Text>
      </ScrollView>
      <NativeCopyButton text={json} action="Copy raw" testID="companion-native-copy-raw" />
    </>
  );
}

/** A checklist's progress and steps, or a proposed plan with copy and implement actions. */
function NativePlanBody({
  choiceId,
  plan,
  text,
  preview,
  open,
  onToggle,
  onDisclosure,
  onImplement,
  implementing,
}: {
  choiceId: string;
  plan: NativeSessionPlan;
  text: string;
  preview?: NativeMessagePreview;
  open: boolean;
  onToggle: () => void;
  onDisclosure: () => void;
  onImplement?: () => void;
  implementing?: boolean;
}) {
  if (plan.kind === 'proposal')
    return (
      <>
        <NativeMessageText
          choiceId={choiceId}
          text={text}
          preview={preview}
          markdown
          onDisclosure={onDisclosure}
        />
        <NativeCopyButton text={plan.text} action="Copy plan" testID="companion-native-plan-copy" />
        {onImplement ? (
          <Pressable
            testID="companion-native-plan-implement"
            accessibilityRole="button"
            accessibilityState={{ disabled: implementing }}
            disabled={implementing}
            style={styles.messageToggle}
            onPress={onImplement}
          >
            <Text style={styles.buttonText}>{implementing ? 'Implementing…' : 'Implement'}</Text>
          </Pressable>
        ) : null}
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
              {nativePlanStepMark(step.status)} {step.text}
            </Text>
          ))}
          <NativeCopyButton
            text={[
              plan.text,
              ...plan.steps.map((step) => `${nativePlanStepMark(step.status)} ${step.text}`),
            ]
              .filter(Boolean)
              .join('\n')}
            action="Copy plan"
            testID="companion-native-plan-copy"
          />
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
      <NativeCopyButton text={text} />
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
  choiceId = 'pending',
  text,
  preview,
  muted = false,
  markdown = false,
  onDisclosure,
}: {
  choiceId?: string;
  text: string;
  preview?: NativeMessagePreview;
  muted?: boolean;
  /** The whole text is markdown; a collapsed preview stays plain. */
  markdown?: boolean;
  onDisclosure: () => void;
}) {
  const [expanded, setExpanded] = useViewToggle(`native-text:${choiceId}`);
  const whole = !preview || expanded;
  return (
    <>
      {markdown && whole ? (
        <FormattedDocument blocks={formatDocumentCached('plan.md', text)} />
      ) : preview && !expanded ? (
        // A preview may end inside an address: it stays plain until the whole text shows.
        <Text selectable style={muted ? styles.muted : styles.text}>
          {preview.text}
        </Text>
      ) : (
        <NativeLinkedText text={text} style={muted ? styles.muted : styles.text} />
      )}
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
