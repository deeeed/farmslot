import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { nativeStyles as styles } from '../native-conversation/styles/native-conversation.styles';
import { GatewayPairingScanner } from '../settings/components/GatewayPairingScanner';

import { connectionStyles } from './styles/native-connection.styles';
import type { useNativeConnectionController } from './use-native-connection-controller';

type Screen = ReturnType<typeof useNativeConnectionController>;
export function NativeConnectionScreen({
  viewModel: vm,
  actions,
  onOpenWorkspace,
}: Screen & { onOpenWorkspace: () => void }) {
  return (
    <ScrollView
      testID="companion-native-connection-screen"
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.heading}>Gateway connection</Text>
      <Text style={connectionStyles.lead}>
        Scan the Command Center pairing QR. Typing a URL or token is only a fallback.
      </Text>
      <Text testID="companion-native-access" style={styles.text}>
        {vm.status} · {vm.access}
      </Text>
      {vm.principalId ? (
        <Text testID="companion-native-principal" style={styles.muted}>
          {vm.principalId}
        </Text>
      ) : null}
      {vm.pairingImportMessage ? <Text style={styles.muted}>{vm.pairingImportMessage}</Text> : null}
      {vm.error || vm.connectionError ? (
        <Text testID="companion-native-connection-error" style={styles.error}>
          {vm.error || vm.connectionError}
        </Text>
      ) : null}
      <Pressable
        testID="companion-connection-scan-qr"
        accessibilityRole="button"
        style={[styles.button, connectionStyles.primaryButton]}
        disabled={vm.busy || vm.pairingInProgress}
        onPress={() => void actions.openPairingScanner()}
      >
        <Text style={connectionStyles.primaryButtonText}>
          {vm.pairingInProgress ? 'Pairing…' : 'Scan pairing QR'}
        </Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable
          testID="companion-native-open-workspace"
          accessibilityRole="button"
          style={styles.button}
          disabled={!vm.canOpen}
          onPress={onOpenWorkspace}
        >
          <Text style={styles.buttonText}>Open workspace</Text>
        </Pressable>
        <Pressable
          testID="companion-native-reconnect"
          accessibilityRole="button"
          style={styles.button}
          disabled={vm.busy}
          onPress={() => void actions.retry()}
        >
          <Text style={styles.buttonText}>Reconnect</Text>
        </Pressable>
      </View>
      <Text style={styles.heading}>Saved gateways</Text>
      {vm.profiles.length === 0 ? (
        <Text style={styles.muted}>No saved gateways yet. Scan a pairing QR to add one.</Text>
      ) : (
        vm.profiles.map((profile, index) => (
          <Pressable
            key={profile.id}
            testID={`companion-native-profile-${index}`}
            accessibilityRole="button"
            accessibilityState={{ selected: profile.id === vm.activeProfileId }}
            style={styles.card}
            disabled={vm.busy}
            onPress={() => void actions.selectProfile(profile.id)}
          >
            <Text style={styles.text}>
              {profile.id === vm.activeProfileId ? '✓ ' : ''}
              {profile.name}
            </Text>
            <Text style={styles.muted}>{profile.url}</Text>
          </Pressable>
        ))
      )}
      <Pressable
        testID="companion-connection-manual-toggle"
        accessibilityRole="button"
        style={connectionStyles.toggle}
        onPress={actions.toggleManual}
      >
        <Text style={connectionStyles.toggleText}>
          {vm.manualOpen ? 'Hide manual setup' : 'Enter details manually'}
        </Text>
      </Pressable>
      {vm.manualOpen ? (
        <>
          <Text style={styles.heading}>Add gateway</Text>
          <TextInput
            testID="companion-native-profile-name"
            accessibilityLabel="Profile name"
            value={vm.name}
            onChangeText={actions.setName}
            style={styles.input}
            editable={!vm.busy}
          />
          <TextInput
            testID="companion-native-profile-url"
            accessibilityLabel="Gateway WebSocket URL"
            value={vm.url}
            onChangeText={actions.setUrl}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!vm.busy}
          />
          <View style={styles.row}>
            {(['token', 'password', 'none'] as const).map((mode) => (
              <Pressable
                key={mode}
                testID={`companion-native-auth-${mode}`}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === vm.authMode }}
                style={styles.button}
                disabled={vm.busy}
                onPress={() => actions.setAuthMode(mode)}
              >
                <Text style={styles.buttonText}>
                  {mode === vm.authMode ? '✓ ' : ''}
                  {mode}
                </Text>
              </Pressable>
            ))}
          </View>
          {vm.authMode !== 'none' ? (
            <TextInput
              testID="companion-native-profile-secret"
              accessibilityLabel="Gateway credential"
              value={vm.secret}
              onChangeText={actions.setSecret}
              style={styles.input}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!vm.busy}
            />
          ) : null}
          <Pressable
            testID="companion-native-profile-save"
            accessibilityRole="button"
            style={styles.button}
            disabled={vm.busy}
            onPress={() => void actions.save()}
          >
            <Text style={styles.buttonText}>{vm.busy ? 'Connecting…' : 'Save and connect'}</Text>
          </Pressable>
        </>
      ) : null}
      <GatewayPairingScanner
        visible={vm.pairingScannerOpen}
        inProgress={vm.pairingInProgress}
        onBarcodeScanned={(result) => void actions.handlePairingBarcodeScanned(result)}
        onClose={actions.closePairingScanner}
      />
    </ScrollView>
  );
}
