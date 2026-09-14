import { Pressable, Text, View } from 'react-native';

import { nativeStyles as styles } from '../styles/native-conversation.styles';
import type { useNativeProfileSelection } from '../use-native-profile-selection';

type ProfileSelection = ReturnType<typeof useNativeProfileSelection>;
export function NativeProfilePicker({
  viewModel: vm,
  actions,
  disabled,
  locked = false,
}: ProfileSelection & { disabled: boolean; locked?: boolean }) {
  if (!vm.visible) return null;
  return (
    <View testID="companion-native-profiles" style={styles.card}>
      <Text style={styles.text}>Runner configuration</Text>
      {!locked ? (
        <>
          <Pressable
            testID="companion-native-profile-default"
            style={styles.button}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected: !vm.selected }}
            onPress={() => actions.choose('')}
          >
            <Text style={styles.buttonText}>
              {!vm.selected ? '✓ ' : ''}Node default configuration
            </Text>
          </Pressable>
          {vm.profiles.map((profile) => {
            const sameLabel = vm.selected?.profileId === profile.id;
            const selected =
              sameLabel && vm.selected?.accountContextId === profile.accountContextId;
            return (
              <Pressable
                key={profile.id}
                testID={`companion-native-runner-profile-${profile.id}`}
                style={styles.button}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => actions.choose(profile.id)}
              >
                <Text style={styles.buttonText}>
                  {selected ? '✓ ' : sameLabel ? 'Use updated profile: ' : ''}
                  {profile.id}
                </Text>
                <Text selectable style={styles.muted}>
                  {profile.directory}
                </Text>
              </Pressable>
            );
          })}
        </>
      ) : (
        <Text style={styles.muted}>Saved configuration: {vm.selected?.profileId}</Text>
      )}
      {vm.selected && !vm.profiles.some((profile) => profile.id === vm.selected?.profileId) ? (
        <Text style={styles.muted}>Selected profile: {vm.selected.profileId}</Text>
      ) : null}
      {vm.status ? (
        <Text testID="companion-native-profile-status" style={styles.text}>
          {vm.status.account.installed ? vm.status.account.login : 'Runner unavailable'} ·{' '}
          {vm.status.account.version ?? 'Version unavailable'}
        </Text>
      ) : null}
      {vm.reason || vm.error ? (
        <Text testID="companion-native-profile-error" style={styles.error}>
          {vm.reason ?? vm.error}
        </Text>
      ) : null}
      {vm.selected && vm.status && vm.status.account.login !== 'authenticated' ? (
        <>
          <Text style={styles.muted}>
            Run this on the selected node, then refresh login status.
          </Text>
          <Text testID="companion-native-profile-login-command" selectable style={styles.code}>
            {vm.status.loginCommand}
          </Text>
        </>
      ) : null}
      <Text style={styles.muted}>
        Profiles select configuration directories. Signing in again in the same directory keeps
        saved conversations.
      </Text>
      <Pressable
        testID="companion-native-profile-refresh"
        accessibilityRole="button"
        style={styles.button}
        disabled={disabled}
        onPress={actions.refresh}
      >
        <Text style={styles.buttonText}>
          {vm.loading ? 'Checking profiles…' : 'Refresh profiles'}
        </Text>
      </Pressable>
    </View>
  );
}
