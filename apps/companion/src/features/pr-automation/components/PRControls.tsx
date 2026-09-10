import React, { useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';

import { colors } from '../../../lib/theme';
import { styles } from '../styles/pr-automation-styles';

export function PRButton({
  label,
  onPress,
  disabled = false,
  selected = false,
  testID,
  expanded,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  testID?: string;
  expanded?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected, ...(expanded !== undefined ? { expanded } : {}) }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, selected && styles.selected, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function PRDisclosure({
  label,
  testID,
  children,
}: {
  label: string;
  testID: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.field}>
      <PRButton
        label={`${open ? 'Hide' : 'Show'} ${label}`}
        testID={testID}
        expanded={open}
        onPress={() => setOpen(!open)}
      />
      {open && children}
    </View>
  );
}
export function PRInput({
  label,
  value,
  onChange,
  disabled,
  testID,
  numeric = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  testID?: string;
  numeric?: boolean;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.muted}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        testID={testID}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        autoCorrect={false}
        multiline={multiline}
        autoCapitalize="none"
        keyboardType={numeric ? 'numeric' : 'default'}
        style={styles.input}
        placeholderTextColor={colors.textMuted}
      />
    </View>
  );
}
export function PRToggle({
  label,
  value,
  onChange,
  disabled,
  testID,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.switch}>
      <Text style={styles.switchLabel}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        testID={testID}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      />
    </View>
  );
}
