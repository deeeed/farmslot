import { type BarcodeScanningResult, CameraView } from 'expo-camera';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing } from '../../../lib/theme';
import { pairingScannerStyles as styles } from '../styles/gateway-pairing-scanner.styles';

export function GatewayPairingScanner({
  visible,
  inProgress,
  onBarcodeScanned,
  onClose,
}: {
  visible: boolean;
  inProgress: boolean;
  onBarcodeScanned: (result: BarcodeScanningResult) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView testID="companion-pairing-scanner" style={styles.container}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={inProgress ? undefined : onBarcodeScanned}
        />
        <View style={[styles.overlay, { paddingBottom: spacing.xl + insets.bottom }]}>
          <Text style={styles.title}>Scan Farmslot pairing QR</Text>
          <Text style={styles.help}>
            Command Center → connection status → Generate QR. Keep this screen open until pairing
            completes.
          </Text>
          {inProgress ? (
            <View style={styles.progress}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.help}>Exchanging credential…</Text>
            </View>
          ) : null}
          <Pressable
            testID="companion-pairing-scanner-cancel"
            accessibilityRole="button"
            style={styles.cancel}
            onPress={onClose}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
