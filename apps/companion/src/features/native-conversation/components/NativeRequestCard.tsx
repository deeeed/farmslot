import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { NativeSessionEvent, NativeSessionResponse } from '@farmslot/protocol';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

export function NativeRequestCard({
  event,
  disabled,
  attempted,
  respond,
}: {
  event: NativeSessionEvent;
  disabled: boolean;
  attempted: boolean;
  respond: (requestId: string, response: NativeSessionResponse) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const request = event.request;
  if (!request) return null;
  const questions = request.questions ?? [];
  const submittedAnswers = Object.fromEntries(
    questions.map((question) => {
      const custom = customAnswers[question.id]?.trim();
      return [question.id, custom ? [custom] : (answers[question.id] ?? [])];
    }),
  );
  const locked = disabled || attempted || event.responseState === 'unknown';
  return (
    <View style={styles.card} testID={`companion-native-request-${request.id}`}>
      <Text style={styles.heading}>{request.title}</Text>
      {request.detail ? (
        <Text selectable style={styles.text}>
          {request.detail}
        </Text>
      ) : null}
      {request.tool ? (
        <ScrollView style={styles.detail} nestedScrollEnabled>
          <Text selectable style={styles.code}>
            {JSON.stringify(request.tool, null, 2)}
          </Text>
        </ScrollView>
      ) : null}
      {event.type === 'approval.requested' && event.data ? (
        <View>
          <Text style={styles.heading}>Action details</Text>
          <ScrollView style={styles.detail} nestedScrollEnabled>
            <Text selectable testID="companion-native-approval-details" style={styles.code}>
              {JSON.stringify(event.data, null, 2)}
            </Text>
          </ScrollView>
        </View>
      ) : null}
      {attempted || event.responseState === 'unknown' ? (
        <Text style={styles.muted}>
          Response submitted. Waiting for the runner to confirm; refresh to reconcile.
        </Text>
      ) : null}
      {event.type === 'question.requested' ? (
        <>
          {questions.map((question, index) => (
            <View key={question.id} style={styles.card}>
              <Text style={styles.text}>{question.prompt}</Text>
              {question.options.map((option) => {
                const selected = (answers[question.id] ?? []).includes(option.label);
                return (
                  <Pressable
                    key={option.label}
                    disabled={locked}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: locked }}
                    style={[styles.button, selected && styles.selected, locked && styles.disabled]}
                    onPress={() =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: question.multiSelect
                          ? selected
                            ? (current[question.id] ?? []).filter((value) => value !== option.label)
                            : [...(current[question.id] ?? []), option.label]
                          : [option.label],
                      }))
                    }
                  >
                    <Text style={styles.buttonText}>{option.label}</Text>
                    {option.description ? (
                      <Text style={styles.muted}>{option.description}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
              <TextInput
                testID={`companion-native-custom-answer-${index}`}
                accessibilityLabel={`Custom answer: ${question.prompt}`}
                placeholder="Custom answer"
                placeholderTextColor="#888"
                editable={!locked}
                style={styles.input}
                value={customAnswers[question.id] ?? ''}
                onChangeText={(value) =>
                  setCustomAnswers((current) => ({ ...current, [question.id]: value }))
                }
              />
            </View>
          ))}
          <Pressable
            testID="companion-native-answer"
            accessibilityRole="button"
            disabled={
              locked ||
              !questions.length ||
              questions.some(
                (question) => !submittedAnswers[question.id]?.some((value) => value.trim()),
              )
            }
            style={[styles.button, locked && styles.disabled]}
            onPress={() => respond(request.id, { answers: submittedAnswers })}
          >
            <Text style={styles.buttonText}>Send answers</Text>
          </Pressable>
        </>
      ) : (
        <View style={styles.row}>
          {(['approve', 'deny'] as const).map((decision) => (
            <Pressable
              key={decision}
              testID={`companion-native-${decision}`}
              accessibilityRole="button"
              disabled={locked}
              style={[styles.button, locked && styles.disabled]}
              onPress={() => respond(request.id, { decision })}
            >
              <Text style={styles.buttonText}>{decision === 'approve' ? 'Approve' : 'Deny'}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {disabled && !attempted ? (
        <Text style={styles.muted}>
          This request cannot be answered in the current session state.
        </Text>
      ) : null}
    </View>
  );
}
