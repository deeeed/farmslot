import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { GatewayProfile } from '../../../lib/gateway-profiles';
import { colors } from '../../../lib/theme';
import { useCommandCenterUrlController } from '../use-command-center-url-controller';

export function CommandCenterUrlEditor({ profile }: { profile: GatewayProfile }) {
  const model = useCommandCenterUrlController(profile);
  return (
    <View style={styles.container}>
      <Text style={styles.label}>Command Center URL</Text>
      <TextInput
        testID={`companion-command-center-url-${profile.id}`}
        accessibilityLabel={`Command Center URL for ${profile.name}`}
        value={model.value}
        onChangeText={model.setValue}
        editable={!model.saving}
        placeholder="https://cc.example.org/"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
      />
      <Pressable
        testID={`companion-save-command-center-url-${profile.id}`}
        accessibilityRole="button"
        onPress={() => {
          Keyboard.dismiss();
          void model.save();
        }}
        disabled={model.saving}
        style={styles.save}
      >
        <Text style={styles.label}>{model.saving ? 'Saving…' : 'Save web URL'}</Text>
      </Pressable>
      {model.message ? (
        <Text accessibilityLiveRegion="polite" style={styles.message}>
          {model.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8, marginTop: 12 },
  label: { color: colors.textPrimary, fontSize: 14 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.textPrimary,
  },
  save: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 8,
  },
  message: { color: colors.textSecondary, fontSize: 13 },
});
