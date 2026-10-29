import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ReviewDispatchPicker } from '../../review-dispatch/ReviewDispatchPicker';
import { nativeStyles as styles } from '../styles/native-conversation.styles';
import type { useNativeSessionSetup } from '../use-native-session-setup';

import { NativeProfilePicker } from './NativeProfilePicker';

type Setup = ReturnType<typeof useNativeSessionSetup>;
export function NativeSessionSetup({
  viewModel: vm,
  actions,
  onCreate,
}: Setup & { onCreate: () => void }) {
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const runner = vm.catalog?.runners.find((item) => item.runner === vm.runner);
  const selectedWorkspace = vm.catalog?.contexts[vm.contextIndex];
  return (
    <View testID="companion-native-setup" style={styles.card}>
      <Text style={styles.heading}>New conversation</Text>
      <Text style={styles.muted}>Workspace</Text>
      {selectedWorkspace ? (
        <View testID="companion-native-selected-workspace">
          <Text style={styles.text}>
            {selectedWorkspace.label} · {selectedWorkspace.executionNodeId ?? 'local'}
          </Text>
          <Text style={styles.muted}>{selectedWorkspace.cwd}</Text>
        </View>
      ) : null}
      <Pressable
        testID="companion-native-workspace-choose"
        accessibilityRole="button"
        accessibilityState={{ expanded: choosingWorkspace }}
        style={styles.button}
        disabled={vm.controlsDisabled}
        onPress={() => setChoosingWorkspace((value) => !value)}
      >
        <Text style={styles.buttonText}>
          {choosingWorkspace ? 'Hide workspaces' : 'Change workspace'}
        </Text>
      </Pressable>
      {vm.contextUnavailable ? (
        <Text style={styles.error}>
          The selected workspace is unavailable. Choose another workspace.
        </Text>
      ) : null}
      {choosingWorkspace
        ? vm.catalog?.contexts.map((context, index) => (
            <Pressable
              key={`${context.executionNodeId}:${context.cwd}`}
              testID={`companion-native-context-${index}`}
              accessibilityRole="button"
              accessibilityState={{ selected: index === vm.contextIndex }}
              style={styles.button}
              disabled={vm.controlsDisabled}
              onPress={() => {
                actions.selectContext(index);
                setChoosingWorkspace(false);
              }}
            >
              <Text style={styles.buttonText}>
                {index === vm.contextIndex ? '✓ ' : ''}
                {context.label} · {context.executionNodeId ?? 'local'}
              </Text>
              <Text style={styles.muted}>{context.cwd}</Text>
            </Pressable>
          ))
        : null}
      {vm.executionPicker ? (
        <ReviewDispatchPicker
          model={vm.executionPicker}
          review={false}
          discover={false}
          disabled={vm.controlsDisabled}
          testID="companion-native-execution"
          onChange={() => {
            const selection = vm.executionPicker?.selection;
            if (!selection) return;
            actions.selectRunner(selection.runner);
            actions.selectModel(selection.model ?? '');
          }}
        />
      ) : null}
      <NativeProfilePicker
        viewModel={vm.profiles}
        actions={actions.profiles}
        disabled={vm.controlsDisabled}
      />
      {(runner?.modes.length ?? 0) > 1 ? (
        <View style={styles.row}>
          {runner?.modes.map((mode) => (
            <Pressable
              key={mode}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === vm.mode }}
              testID={`companion-native-mode-${mode}`}
              style={styles.button}
              disabled={vm.controlsDisabled}
              onPress={() => actions.selectMode(mode)}
            >
              <Text style={styles.buttonText}>
                {mode === vm.mode ? '✓ ' : ''}
                {mode === 'plan' ? 'Plan' : 'Default'}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {!vm.loading && !vm.catalog?.contexts.length ? (
        <Text style={styles.muted}>No workspaces are available for this account.</Text>
      ) : null}
      <View style={styles.row}>
        <Pressable
          testID="companion-native-create"
          accessibilityRole="button"
          accessibilityState={{ disabled: !vm.canCreate }}
          style={styles.button}
          disabled={!vm.canCreate}
          onPress={onCreate}
        >
          <Text style={styles.buttonText}>{vm.creating ? 'Starting…' : 'Start conversation'}</Text>
        </Pressable>
        {vm.catalogError ? (
          <Pressable
            testID="companion-native-catalog-refresh"
            accessibilityRole="button"
            style={styles.button}
            disabled={vm.creating}
            onPress={actions.refresh}
          >
            <Text style={styles.buttonText}>
              {vm.loading ? 'Loading…' : 'Retry reading workspaces'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
