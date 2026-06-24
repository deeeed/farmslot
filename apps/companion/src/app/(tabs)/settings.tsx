import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from 'expo-asset';
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import voiceAsrTestClipAssetModule from '../../../assets/asr/voice-command-status.wav';
import { AppEnvironmentCard } from '../../components/AppEnvironmentCard';
import { AppUpdateStatusCard } from '../../components/AppUpdateStatusCard';
import { AppVersionBanner } from '../../components/AppVersionBanner';
import {
  microphonePermissionIsBlocked,
  microphonePermissionSetupState,
} from '../../lib/audio-permission-state';
import {
  getMicrophonePermissionState,
  type MicrophonePermissionState,
  requestMicrophonePermissionState,
} from '../../lib/audio-permissions';
import { type GatewayAuthCredentials, testGatewayConnection } from '../../lib/gateway-client';
import {
  exchangeGatewayPairingQr,
  parseGatewayPairingQr,
  profileFromPairingResult,
} from '../../lib/gateway-pairing';
import {
  selectPreferredGatewayProfile,
  sortGatewayProfilesForAutoConnect,
} from '../../lib/gateway-profile-selection';
import {
  type GatewayProfile,
  type GatewayProfileAuthMode,
  gatewayProfileKindUrlError,
  mobileGatewayProfileUrlError,
  readGatewayProfileSecret,
} from '../../lib/gateway-profiles';
import { isStoreScreenshotMode } from '../../lib/store-screenshot-mode';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import {
  downloadVoiceAsrModel,
  formatVoiceAsrSmokeTestResult,
  getConfiguredSherpaAsrModelId,
  getPreferredVoiceAsrModelId,
  getStoredVoiceAsrModelPreference,
  getVoiceAsrModelBadge,
  getVoiceAsrModelSourceLabel,
  getVoiceAsrModelState,
  getVoiceAsrStorageRequirementLabel,
  getVoiceCopilotRuntimeState,
  resetVoiceAsrModel,
  smokeTestVoiceAsrModelFile,
  VOICE_ASR_MODELS,
  VOICE_MODEL_STORAGE_KEY,
  type VoiceAsrModelState,
  type VoiceCopilotRuntimeState,
} from '../../lib/voice-copilot';
import { useConnectionStore } from '../../store/connection';
import { type TmuxPrefixOption, useTerminalPrefsStore } from '../../store/terminal-prefs';

const FARMSLOT_PROJECT_URL = 'https://farmslot.io';
const FARMSLOT_PRIVACY_URL = 'https://siteed.net/farmslot/privacy';

function microphonePermissionColor(
  status: ReturnType<typeof microphonePermissionSetupState>['status'],
): string {
  if (status === 'ready') return colors.statusOk;
  if (status === 'checking') return colors.statusWarn;
  return colors.statusFail;
}

function makeCustomProfileId(): string {
  return `custom-${Date.now()}`;
}

async function smokeTestVoiceModel(modelId: string): Promise<string> {
  const [asset] = await Asset.loadAsync(voiceAsrTestClipAssetModule);
  const fileUri = asset.localUri ?? asset.uri;
  if (!fileUri) throw new Error('Bundled ASR test clip did not resolve to a file URI.');
  const result = await smokeTestVoiceAsrModelFile(fileUri, modelId);
  return formatVoiceAsrSmokeTestResult(result);
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const {
    gatewayUrl,
    profiles,
    activeProfileId,
    setActiveProfile,
    saveProfile,
    deleteProfile,
    setGatewayUrl,
    setProfileAuth,
    status,
    lastSyncError,
    connect,
  } = useConnectionStore();
  const tmuxPrefix = useTerminalPrefsStore((s) => s.tmuxPrefix);
  const setTmuxPrefix = useTerminalPrefsStore((s) => s.setTmuxPrefix);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0],
    [activeProfileId, profiles],
  );
  const [recentImportedProfiles, setRecentImportedProfiles] = useState<GatewayProfile[]>([]);
  const displayedProfiles = useMemo(
    () => mergeVisibleProfiles(profiles, recentImportedProfiles),
    [profiles, recentImportedProfiles],
  );
  const [profileName, setProfileName] = useState('Remote WSS');
  const [urlInput, setUrlInput] = useState(gatewayUrl);
  const [profileKind, setProfileKind] = useState<GatewayProfile['kind']>('remote');
  const [authMode, setAuthMode] = useState<GatewayProfileAuthMode>(
    activeProfile?.authMode ?? 'none',
  );
  const [authSecret, setAuthSecret] = useState('');
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [pairingScannerOpen, setPairingScannerOpen] = useState(false);
  const [pairingInProgress, setPairingInProgress] = useState(false);
  const [pairingImportMessage, setPairingImportMessage] = useState<string | null>(null);
  const [advancedGatewaySetupOpen, setAdvancedGatewaySetupOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [connectionTestInProgress, setConnectionTestInProgress] = useState(false);
  const [connectionTestStatus, setConnectionTestStatus] = useState<string | null>(null);
  const [connectionTestFailed, setConnectionTestFailed] = useState(false);
  const configuredVoiceModelId = getConfiguredSherpaAsrModelId();
  const voiceModelSelectionLocked = Boolean(configuredVoiceModelId);
  const [selectedVoiceModelId, setSelectedVoiceModelId] = useState(getPreferredVoiceAsrModelId);
  const [voiceModelState, setVoiceModelState] = useState<VoiceAsrModelState | null>(null);
  const [voiceRuntimeState, setVoiceRuntimeState] = useState<VoiceCopilotRuntimeState | null>(null);
  const [isDownloadingVoiceModel, setIsDownloadingVoiceModel] = useState(false);
  const [isResettingVoiceModel, setIsResettingVoiceModel] = useState(false);
  const [isTestingVoiceAsr, setIsTestingVoiceAsr] = useState(false);
  const [voiceModelMessage, setVoiceModelMessage] = useState<string | null>(null);
  const [voiceModelMessageFailed, setVoiceModelMessageFailed] = useState(false);
  const [microphonePermission, setMicrophonePermission] =
    useState<MicrophonePermissionState | null>(null);
  const [microphonePermissionMessage, setMicrophonePermissionMessage] = useState<string | null>(
    null,
  );
  const [microphonePermissionFailed, setMicrophonePermissionFailed] = useState(false);
  const [isRequestingMicrophonePermission, setIsRequestingMicrophonePermission] = useState(false);
  const voiceRuntimePending = !voiceRuntimeState;
  const voiceRuntimeUnavailable = voiceRuntimeState?.available === false;
  const voiceModelActionBlocked =
    isDownloadingVoiceModel ||
    isResettingVoiceModel ||
    isTestingVoiceAsr ||
    voiceRuntimePending ||
    voiceRuntimeUnavailable;
  const selectedVoiceModel =
    voiceModelState?.model ??
    VOICE_ASR_MODELS.find((model) => model.id === selectedVoiceModelId) ??
    VOICE_ASR_MODELS[0];
  const voiceModelStatusLabel = voiceRuntimePending
    ? 'checking'
    : voiceRuntimeUnavailable
      ? 'runtime unavailable'
      : voiceModelState?.status === 'ready'
        ? 'ready'
        : voiceModelState?.status === 'downloading'
          ? 'downloading'
          : voiceModelState?.status === 'extracting'
            ? 'extracting'
            : voiceModelState?.status === 'incomplete'
              ? 'incomplete'
              : 'not downloaded';
  const voiceModelStatusColor =
    voiceModelState?.status === 'ready'
      ? colors.statusOk
      : voiceRuntimeUnavailable || voiceModelState?.status === 'incomplete'
        ? colors.statusFail
        : colors.statusWarn;
  const microphoneSetupState = useMemo(
    () => microphonePermissionSetupState(microphonePermission),
    [microphonePermission],
  );
  const microphoneStatusColor = microphonePermissionColor(microphoneSetupState.status);
  const microphoneStatusLabel = microphoneSetupState.label;
  const microphonePermissionMissing = !isStoreScreenshotMode && microphoneSetupState.needsAction;
  const microphoneAttentionColor = microphoneSetupState.blocked
    ? colors.statusFail
    : colors.statusWarn;
  const microphonePermissionActionLabel = isRequestingMicrophonePermission
    ? 'Checking…'
    : microphoneSetupState.actionLabel;
  const showVoiceModelStatusDetail = Boolean(
    voiceModelState &&
    (voiceModelState.status !== 'ready' ||
      voiceModelMessageFailed ||
      isDownloadingVoiceModel ||
      isResettingVoiceModel ||
      isTestingVoiceAsr),
  );
  const activeProfileHasConnectionIssue = Boolean(
    activeProfile && (status === 'disconnected' || lastSyncError),
  );
  const showProfileAuthSetup = advancedGatewaySetupOpen || activeProfileHasConnectionIssue;

  const refreshVoiceModelState = useCallback(
    async (modelId = selectedVoiceModelId) => {
      try {
        const state = await getVoiceAsrModelState(modelId);
        setVoiceModelState(state);
        setVoiceModelMessage(state.message);
        setVoiceModelMessageFailed(state.status !== 'ready');
      } catch (error) {
        setVoiceModelMessage(`Failed to inspect transcription model: ${(error as Error).message}`);
        setVoiceModelMessageFailed(true);
      }
    },
    [selectedVoiceModelId],
  );

  const refreshMicrophonePermission = useCallback(async () => {
    try {
      const permission = await getMicrophonePermissionState();
      setMicrophonePermission(permission);
      const setupState = microphonePermissionSetupState(permission);
      setMicrophonePermissionFailed(setupState.needsAction);
      setMicrophonePermissionMessage(setupState.message);
    } catch (error) {
      setMicrophonePermission(null);
      setMicrophonePermissionFailed(true);
      setMicrophonePermissionMessage(
        `Failed to inspect microphone permission: ${(error as Error).message}`,
      );
    }
  }, []);

  const openMicrophoneAppSettings = useCallback(async () => {
    try {
      await Linking.openSettings();
      setMicrophonePermissionFailed(true);
      setMicrophonePermissionMessage(
        'Opened system settings. Return here after enabling Microphone for Farmslot.',
      );
    } catch (error) {
      setMicrophonePermissionFailed(true);
      setMicrophonePermissionMessage(`Failed to open system settings: ${(error as Error).message}`);
    }
  }, []);

  const handleRequestMicrophonePermission = async () => {
    if (isRequestingMicrophonePermission) return;
    setIsRequestingMicrophonePermission(true);
    setMicrophonePermissionFailed(false);
    try {
      if (microphonePermission && microphonePermissionIsBlocked(microphonePermission)) {
        await openMicrophoneAppSettings();
        return;
      }
      const permission = await requestMicrophonePermissionState();
      setMicrophonePermission(permission);
      setMicrophonePermissionFailed(!permission.granted);
      const setupState = microphonePermissionSetupState(permission);
      setMicrophonePermissionMessage(
        permission.granted
          ? 'Microphone permission granted. Voice mode can now record instructions.'
          : setupState.message,
      );
      if (!permission.granted && setupState.blocked) {
        Alert.alert(
          'Microphone blocked',
          'Voice mode cannot record because microphone access was skipped or blocked. Open app settings and allow Microphone for Farmslot.',
          [
            { text: 'Not Now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void openMicrophoneAppSettings() },
          ],
        );
      }
    } catch (error) {
      setMicrophonePermissionFailed(true);
      setMicrophonePermissionMessage(
        `Microphone permission request failed: ${(error as Error).message}`,
      );
    } finally {
      setIsRequestingMicrophonePermission(false);
      void refreshMicrophonePermission();
    }
  };

  useEffect(() => {
    void refreshMicrophonePermission();
  }, [refreshMicrophonePermission]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refreshMicrophonePermission();
    });
    return () => subscription.remove();
  }, [refreshMicrophonePermission]);

  useEffect(() => {
    let disposed = false;
    getVoiceCopilotRuntimeState()
      .then((state) => {
        if (!disposed) setVoiceRuntimeState(state);
      })
      .catch((error: Error) => {
        if (!disposed) {
          setVoiceRuntimeState({
            available: false,
            message: `Voice runtime check failed: ${error.message}`,
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    AsyncStorage.getItem(VOICE_MODEL_STORAGE_KEY)
      .then(async (storedModelId) => {
        if (disposed || !storedModelId || configuredVoiceModelId) return;
        const storedPreference = getStoredVoiceAsrModelPreference(storedModelId);
        if (storedPreference.modelId) {
          setSelectedVoiceModelId(storedPreference.modelId);
          return;
        }
        if (storedPreference.shouldRemove) {
          await AsyncStorage.removeItem(VOICE_MODEL_STORAGE_KEY);
          if (!disposed) {
            setVoiceModelMessage(storedPreference.message);
            setVoiceModelMessageFailed(false);
          }
        }
      })
      .catch((error: Error) => {
        if (!disposed) {
          setVoiceModelMessage(`Failed to load voice model preference: ${error.message}`);
          setVoiceModelMessageFailed(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [configuredVoiceModelId]);

  useEffect(() => {
    void refreshVoiceModelState(selectedVoiceModelId);
  }, [refreshVoiceModelState, selectedVoiceModelId]);

  useEffect(() => {
    let disposed = false;
    setAuthMode(activeProfile?.authMode ?? 'none');
    setAuthSecret('');
    if (!activeProfile) return;
    readGatewayProfileSecret(activeProfile)
      .then((secret) => {
        if (!disposed) setAuthSecret(secret ?? '');
      })
      .catch((error: Error) => {
        if (!disposed) Alert.alert('Credential load failed', error.message);
      });
    return () => {
      disposed = true;
    };
  }, [activeProfile]);

  const handleSelectProfile = async (profile: GatewayProfile) => {
    setPairingImportMessage(null);
    setUrlInput(profile.url);
    await ensureVisibleProfileIsSelectable(profile);
    await setActiveProfile(profile.id);
    connect();
  };

  const ensureVisibleProfileIsSelectable = async (profile: GatewayProfile) => {
    if (profiles.some((candidate) => candidate.id === profile.id)) return;
    await saveProfile(profile);
  };

  const handleSaveCurrentUrl = async () => {
    const urlError = mobileGatewayProfileUrlError(urlInput.trim());
    if (urlError) {
      Alert.alert('Invalid URL', urlError);
      return;
    }
    await setGatewayUrl(urlInput.trim());
    connect();
  };

  const handleTestProfile = async (
    profile: GatewayProfile,
    options: { showAlert?: boolean } = {},
  ) => {
    if (connectionTestInProgress) return;
    setConnectionTestInProgress(true);
    setConnectionTestFailed(false);
    setConnectionTestStatus(`Testing ${profile.name} at ${profile.url}…`);
    try {
      const auth = await authCredentialsForProfile(profile);
      if (profile.authMode !== 'none' && Object.keys(auth).length === 0) {
        throw new Error(`No ${profile.authMode} credential is saved for this profile.`);
      }
      const result = await testGatewayConnection(profile.url, auth);
      const message = `${profile.name} works. Authenticated as companion with ${result.authMode} auth in ${result.latencyMs}ms.`;
      await ensureVisibleProfileIsSelectable(profile);
      await setActiveProfile(profile.id);
      connect();
      setConnectionTestStatus(message);
      if (options.showAlert) Alert.alert('Gateway profile works', message);
    } catch (error) {
      const message = `${profile.name} failed: ${(error as Error).message}`;
      setConnectionTestFailed(true);
      setConnectionTestStatus(message);
      if (options.showAlert) Alert.alert('Gateway profile failed', message);
    } finally {
      setConnectionTestInProgress(false);
    }
  };

  const handleAddProfile = async () => {
    const name = profileName.trim();
    const url = urlInput.trim();
    if (!name) {
      Alert.alert('Missing name', 'Enter a profile name.');
      return;
    }
    const urlError = mobileGatewayProfileUrlError(url);
    if (urlError) {
      Alert.alert('Invalid URL', urlError);
      return;
    }
    const profile: GatewayProfile = {
      id: makeCustomProfileId(),
      name,
      url,
      kind: profileKind,
      authMode,
    };
    const kindUrlError = gatewayProfileKindUrlError(profile);
    if (kindUrlError) {
      Alert.alert('Invalid profile kind', kindUrlError);
      return;
    }
    if (authMode !== 'none' && !authSecret.trim()) {
      Alert.alert('Missing credential', `Enter a ${authMode} for this profile.`);
      return;
    }
    await saveProfile(profile, authSecret);
    await setActiveProfile(profile.id);
    connect();
  };

  const handleSaveAuth = async () => {
    if (!activeProfile) return;
    if (authMode !== 'none' && !authSecret.trim()) {
      Alert.alert('Missing credential', `Enter a ${authMode} for ${activeProfile.name}.`);
      return;
    }
    await setProfileAuth(activeProfile.id, authMode, authSecret);
    connect();
  };

  const handleDeleteProfile = async (profile: GatewayProfile) => {
    if (profile.readonly) return;
    await deleteProfile(profile.id);
    connect();
  };

  const handleOpenExternalUrl = useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert('Could not open link', (error as Error).message);
    }
  }, []);

  const handleSelectVoiceModel = async (modelId: string) => {
    if (voiceModelSelectionLocked || isDownloadingVoiceModel || isResettingVoiceModel) return;
    try {
      await AsyncStorage.setItem(VOICE_MODEL_STORAGE_KEY, modelId);
      setSelectedVoiceModelId(modelId);
      setVoiceModelMessage(null);
      setVoiceModelMessageFailed(false);
    } catch (error) {
      setVoiceModelMessage(`Failed to save voice model preference: ${(error as Error).message}`);
      setVoiceModelMessageFailed(true);
    }
  };

  const handleDownloadVoiceModel = async () => {
    if (isDownloadingVoiceModel || isResettingVoiceModel) return;
    if (!voiceRuntimeState) {
      setVoiceModelMessage('Checking Sherpa native runtime before downloading.');
      setVoiceModelMessageFailed(true);
      return;
    }
    if (!voiceRuntimeState.available) {
      setVoiceModelMessage(voiceRuntimeState.message);
      setVoiceModelMessageFailed(true);
      return;
    }
    setIsDownloadingVoiceModel(true);
    setVoiceModelMessageFailed(false);
    try {
      const state = await downloadVoiceAsrModel(selectedVoiceModelId, (nextState) => {
        setVoiceModelState(nextState);
        setVoiceModelMessage(nextState.message);
      });
      setVoiceModelState(state);
      setVoiceModelMessage(`Testing ${state.model.name} with bundled voice clip…`);
      const smokeTestSummary = await smokeTestVoiceModel(selectedVoiceModelId);
      setVoiceModelMessage(`Download OK. Test ${smokeTestSummary}`);
      setVoiceModelMessageFailed(false);
    } catch (error) {
      setVoiceModelMessage(`Model setup failed: ${(error as Error).message}`);
      setVoiceModelMessageFailed(true);
    } finally {
      setIsDownloadingVoiceModel(false);
    }
  };

  const handleResetVoiceModel = async () => {
    if (isDownloadingVoiceModel || isResettingVoiceModel || !voiceModelState) return;
    setIsResettingVoiceModel(true);
    setVoiceModelMessageFailed(false);
    try {
      const state = await resetVoiceAsrModel(selectedVoiceModelId);
      setVoiceModelState(state);
      setVoiceModelMessage(state.message);
      setVoiceModelMessageFailed(state.status !== 'ready');
    } catch (error) {
      setVoiceModelMessage(`Reset failed: ${(error as Error).message}`);
      setVoiceModelMessageFailed(true);
    } finally {
      setIsResettingVoiceModel(false);
    }
  };

  const handleTestVoiceModel = async () => {
    if (isTestingVoiceAsr || isDownloadingVoiceModel || isResettingVoiceModel) return;
    if (!voiceRuntimeState) {
      setVoiceModelMessage('Checking Sherpa native runtime before testing.');
      setVoiceModelMessageFailed(true);
      return;
    }
    if (!voiceRuntimeState.available) {
      setVoiceModelMessage(voiceRuntimeState.message);
      setVoiceModelMessageFailed(true);
      return;
    }
    setIsTestingVoiceAsr(true);
    setVoiceModelMessageFailed(false);
    setVoiceModelMessage(`Testing ${voiceModelState?.model.name ?? selectedVoiceModelId}…`);
    try {
      const smokeTestSummary = await smokeTestVoiceModel(selectedVoiceModelId);
      setVoiceModelMessage(`Test OK: ${smokeTestSummary}`);
      setVoiceModelMessageFailed(false);
    } catch (error) {
      setVoiceModelMessage(`Test failed: ${(error as Error).message}`);
      setVoiceModelMessageFailed(true);
    } finally {
      setIsTestingVoiceAsr(false);
    }
  };

  const handleOpenPairingScanner = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert('Camera permission required', 'Allow camera access to scan a pairing QR.');
        return;
      }
    }
    setPairingInProgress(false);
    setPairingScannerOpen(true);
  };

  const handlePairingBarcodeScanned = async (result: BarcodeScanningResult) => {
    if (pairingInProgress) return;
    setPairingInProgress(true);
    try {
      const payload = parseGatewayPairingQr(result.data);
      const pairedProfileResults = await exchangeGatewayPairingQr(payload);
      const importedProfiles = pairedProfileResults.map((pairedProfileResult) => ({
        profile: profileFromPairingResult(pairedProfileResult),
        secret: pairedProfileResult.secret,
      }));
      setRecentImportedProfiles(importedProfiles.map((importedProfile) => importedProfile.profile));
      for (const importedProfile of importedProfiles) {
        await saveProfile(importedProfile.profile, importedProfile.secret);
      }
      const reachability = await testImportedPairingProfiles(importedProfiles);
      const reachableProfileIds = new Set(
        reachability
          .filter((candidate) => candidate.reachable)
          .map((candidate) => candidate.profile.id),
      );
      const preferredProfile =
        sortGatewayProfilesForAutoConnect(
          importedProfiles.map((candidate) => candidate.profile),
        ).find((profile) => reachableProfileIds.has(profile.id)) ??
        selectPreferredGatewayProfile(importedProfiles.map((candidate) => candidate.profile));
      if (!preferredProfile) throw new Error('Pairing did not return a gateway profile.');
      await setActiveProfile(preferredProfile.id);
      setUrlInput(preferredProfile.url);
      setAuthMode(preferredProfile.authMode ?? 'none');
      const connectedProfile = reachability.find(
        (candidate) => candidate.profile.id === preferredProfile.id && candidate.reachable,
      );
      const importMessage = connectedProfile
        ? `${importedProfiles.length} profile${importedProfiles.length === 1 ? '' : 's'} imported. Connected to ${preferredProfile.name}.`
        : `${importedProfiles.length} profile${importedProfiles.length === 1 ? '' : 's'} imported. Choose a reachable profile below if ${preferredProfile.name} stays disconnected.`;
      setPairingImportMessage(importMessage);
      setConnectionTestFailed(!connectedProfile);
      setConnectionTestStatus(
        connectedProfile
          ? `Pairing test succeeded for ${preferredProfile.name}.`
          : firstPairingReachabilityError(reachability),
      );
      setAdvancedGatewaySetupOpen(false);
      connect();
      setPairingScannerOpen(false);
      Alert.alert('Companion paired', importMessage);
    } catch (error) {
      setPairingInProgress(false);
      Alert.alert('Pairing failed', (error as Error).message);
    }
  };

  return (
    <ScrollView
      style={baseStyles.container}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: styles.content.padding + insets.bottom },
      ]}
    >
      <AppVersionBanner />

      <Text style={styles.sectionTitle}>Gateway Connection</Text>

      <View style={styles.statusRow}>
        <Text style={styles.label}>Status</Text>
        <View style={styles.statusValue}>
          <View
            style={[
              styles.statusDot,
              {
                backgroundColor:
                  status === 'connected'
                    ? colors.statusOk
                    : status === 'connecting'
                      ? colors.statusWarn
                      : colors.statusFail,
              },
            ]}
          />
          <Text style={baseStyles.textPrimary}>{status}</Text>
        </View>
      </View>

      {microphonePermissionMissing ? (
        <View
          style={[
            styles.requiredSetupCard,
            {
              backgroundColor: microphoneAttentionColor + '14',
              borderColor: microphoneAttentionColor + '88',
            },
          ]}
        >
          <View style={styles.requiredSetupCopy}>
            <Text style={[styles.requiredSetupEyebrow, { color: microphoneAttentionColor }]}>
              {microphoneSetupState.blocked
                ? 'Microphone permission blocked'
                : 'Voice mode setup required'}
            </Text>
            <Text style={styles.requiredSetupTitle}>{microphoneSetupState.title}</Text>
            <Text style={styles.requiredSetupText}>{microphoneSetupState.body}</Text>
          </View>
          {microphonePermissionActionLabel ? (
            <Pressable
              style={[
                styles.button,
                styles.compactButton,
                styles.requiredSetupButton,
                isRequestingMicrophonePermission && styles.disabledButton,
              ]}
              onPress={() => void handleRequestMicrophonePermission()}
              disabled={isRequestingMicrophonePermission}
            >
              <Text style={styles.buttonText}>{microphonePermissionActionLabel}</Text>
            </Pressable>
          ) : (
            <ActivityIndicator color={colors.statusWarn} />
          )}
        </View>
      ) : null}

      <View style={styles.infoSection}>
        <View style={styles.gatewayActionHeader}>
          <View style={styles.gatewayActionCopy}>
            <Text style={[styles.sectionTitle, styles.gatewayActionTitle]}>
              Pair from Command Center
            </Text>
            <Text style={styles.helperTextNoMargin}>
              Scan a Command Center QR to import gateway profiles and select the best reachable one.
            </Text>
          </View>
          <Pressable
            style={[styles.button, styles.compactButton]}
            onPress={() => void handleOpenPairingScanner()}
          >
            <Text style={styles.buttonText}>Pair QR</Text>
          </Pressable>
        </View>
        {pairingImportMessage ? (
          <Text style={styles.pairingImportText}>{pairingImportMessage}</Text>
        ) : null}
      </View>

      <View style={styles.infoSection}>
        <View style={styles.gatewayActionHeader}>
          <View style={styles.gatewayActionCopy}>
            <Text style={[styles.sectionTitle, styles.gatewayActionTitle]}>Gateway profiles</Text>
            <Text style={styles.helperTextNoMargin}>
              {activeProfile
                ? `Active: ${activeProfile.name} · ${status}`
                : 'No gateway profile selected.'}
            </Text>
          </View>
        </View>

        <View style={styles.profileList}>
          {displayedProfiles.length === 0 ? (
            <View style={styles.emptyProfileCard}>
              <Text style={styles.profileName}>No profiles yet</Text>
              <Text style={styles.helperTextNoMargin}>Pair from QR to add a gateway profile.</Text>
            </View>
          ) : (
            displayedProfiles.map((profile) => {
              const selected = profile.id === activeProfile?.id;
              return (
                <View
                  key={profile.id}
                  style={[styles.profileCard, selected && styles.profileCardActive]}
                >
                  <Pressable
                    style={styles.profileButton}
                    onPress={() => void handleSelectProfile(profile)}
                  >
                    <View style={styles.profileHeader}>
                      <Text style={styles.profileName}>{profile.name}</Text>
                      <Text style={[styles.profileBadge, selected && styles.profileBadgeActive]}>
                        {selected ? 'Active' : profile.kind}
                      </Text>
                    </View>
                    <Text style={styles.profileUrl}>{profile.url}</Text>
                    <Text style={styles.profileAuth}>
                      Auth:{' '}
                      {profile.authMode && profile.authMode !== 'none' ? profile.authMode : 'none'}
                    </Text>
                  </Pressable>
                  <View style={styles.profileActions}>
                    <Pressable
                      style={[
                        styles.profileActionButton,
                        selected && styles.profileActionButtonActive,
                      ]}
                      onPress={() => void handleSelectProfile(profile)}
                    >
                      <Text
                        style={[
                          styles.profileActionButtonText,
                          selected && styles.profileActionButtonTextActive,
                        ]}
                      >
                        {selected
                          ? status === 'connected'
                            ? 'Connected'
                            : 'Connect'
                          : 'Use profile'}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.profileTestButton}
                      onPress={() => void handleTestProfile(profile, { showAlert: true })}
                      disabled={connectionTestInProgress}
                    >
                      <Text style={styles.profileActionButtonText}>
                        {connectionTestInProgress ? 'Testing…' : 'Test'}
                      </Text>
                    </Pressable>
                    {!profile.readonly ? (
                      <Pressable
                        style={styles.deleteButton}
                        onPress={() => void handleDeleteProfile(profile)}
                      >
                        <Text style={styles.deleteText}>Delete</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })
          )}
        </View>

        {connectionTestStatus ? (
          <Text
            style={[
              styles.connectionTestText,
              styles.connectionTestInline,
              connectionTestFailed ? styles.connectionTestFailed : styles.connectionTestOk,
            ]}
          >
            {connectionTestStatus}
          </Text>
        ) : null}

        <Pressable
          style={styles.advancedToggle}
          onPress={() => setAdvancedGatewaySetupOpen((open) => !open)}
        >
          <Text style={styles.advancedToggleText}>
            {advancedGatewaySetupOpen ? 'Hide manual setup' : 'Advanced manual setup'}
          </Text>
        </Pressable>

        {advancedGatewaySetupOpen ? (
          <>
            <View style={styles.field}>
              <Text style={styles.label}>Gateway URL</Text>
              <TextInput
                style={styles.input}
                value={urlInput}
                onChangeText={setUrlInput}
                placeholder="ws://your-mac.local:7777/ws or wss://your-gateway.example/ws"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>

            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.button, styles.secondaryButton]}
                onPress={handleSaveCurrentUrl}
              >
                <Text style={styles.buttonText}>Use URL</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </View>

      {!isStoreScreenshotMode ? (
        <View style={styles.infoSection}>
          <View style={styles.voiceSectionHeader}>
            <View style={styles.voiceSectionTitleBlock}>
              <Text style={[styles.sectionTitle, styles.voiceSectionTitle]}>
                Voice Transcription
              </Text>
              <Text style={styles.voiceSectionSubtitle} numberOfLines={1}>
                {selectedVoiceModel.name} · {getVoiceAsrModelBadge(selectedVoiceModel)}
              </Text>
            </View>
            <View style={[styles.voiceStatusPill, { borderColor: voiceModelStatusColor + '88' }]}>
              <View style={[styles.voiceStatusDot, { backgroundColor: voiceModelStatusColor }]} />
              <Text style={[styles.voiceStatusText, { color: voiceModelStatusColor }]}>
                {voiceModelStatusLabel}
              </Text>
            </View>
          </View>
          <View
            style={[
              styles.voicePermissionCard,
              microphonePermissionMissing && styles.voicePermissionCardNeedsAction,
              microphonePermissionMissing && {
                backgroundColor: microphoneAttentionColor + '14',
                borderColor: microphoneAttentionColor + '88',
              },
            ]}
          >
            <View style={styles.voicePermissionHeader}>
              <View style={styles.voicePermissionTitleBlock}>
                <Text style={styles.voicePermissionTitle}>{microphoneSetupState.title}</Text>
                <Text style={styles.voicePermissionText}>{microphoneSetupState.body}</Text>
              </View>
              <View style={[styles.voiceStatusPill, { borderColor: microphoneStatusColor + '88' }]}>
                <View style={[styles.voiceStatusDot, { backgroundColor: microphoneStatusColor }]} />
                <Text style={[styles.voiceStatusText, { color: microphoneStatusColor }]}>
                  {microphoneStatusLabel}
                </Text>
              </View>
            </View>
            {microphonePermissionMessage ? (
              <Text
                style={[
                  styles.voicePermissionMessage,
                  microphonePermissionFailed
                    ? styles.connectionTestFailed
                    : styles.connectionTestOk,
                ]}
              >
                {microphonePermissionMessage}
              </Text>
            ) : null}
            {microphonePermissionMissing && microphonePermissionActionLabel ? (
              <Pressable
                style={[
                  styles.button,
                  styles.compactButton,
                  isRequestingMicrophonePermission && styles.disabledButton,
                ]}
                onPress={() => void handleRequestMicrophonePermission()}
                disabled={isRequestingMicrophonePermission}
              >
                <Text style={styles.buttonText}>{microphonePermissionActionLabel}</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.voiceModelChoices}>
            {VOICE_ASR_MODELS.map((model) => {
              const selected = model.id === selectedVoiceModelId;
              return (
                <Pressable
                  key={model.id}
                  style={[
                    styles.voiceModelChoice,
                    selected && styles.voiceModelChoiceActive,
                    voiceModelSelectionLocked && styles.disabledButton,
                  ]}
                  onPress={() => void handleSelectVoiceModel(model.id)}
                  disabled={
                    voiceModelSelectionLocked || isDownloadingVoiceModel || isResettingVoiceModel
                  }
                >
                  <Text
                    style={[styles.voiceModelName, selected && styles.voiceModelNameActive]}
                    numberOfLines={1}
                  >
                    {model.name}
                  </Text>
                  <Text style={styles.voiceModelMeta} numberOfLines={2}>
                    {getVoiceAsrModelBadge(model)} · {getVoiceAsrStorageRequirementLabel(model)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {showVoiceModelStatusDetail && voiceModelState ? (
            <View style={styles.voiceModelStatusCard}>
              <Text style={styles.voiceModelStatusTitle}>
                {voiceModelState.model.name} · {getVoiceAsrModelSourceLabel(voiceModelState.source)}
              </Text>
              <Text
                style={[
                  styles.voiceModelStatusText,
                  voiceModelMessageFailed ? styles.connectionTestFailed : styles.connectionTestOk,
                ]}
              >
                {voiceModelMessage ?? voiceModelState.message}
              </Text>
              {voiceModelState.progress != null && voiceModelState.status !== 'ready' ? (
                <View style={styles.voiceModelProgressTrack}>
                  <View
                    style={[
                      styles.voiceModelProgressFill,
                      { width: `${Math.round(voiceModelState.progress * 100)}%` },
                    ]}
                  />
                </View>
              ) : null}
              {voiceRuntimeState ? (
                <Text style={styles.voiceRuntimeText}>{voiceRuntimeState.message}</Text>
              ) : null}
            </View>
          ) : null}
          <View style={styles.buttonRowCompact}>
            {voiceModelState?.status !== 'ready' && voiceModelState?.source !== 'configured' ? (
              <Pressable
                style={[
                  styles.button,
                  styles.compactButton,
                  voiceModelActionBlocked && styles.disabledButton,
                ]}
                onPress={() => void handleDownloadVoiceModel()}
                disabled={voiceModelActionBlocked}
              >
                <Text style={styles.buttonText}>
                  {voiceRuntimePending
                    ? 'Checking Runtime…'
                    : isDownloadingVoiceModel
                      ? 'Setting Up…'
                      : 'Download Model'}
                </Text>
              </Pressable>
            ) : null}
            {voiceModelState?.status === 'ready' ? (
              <Pressable
                style={[
                  styles.button,
                  styles.secondaryButton,
                  styles.compactButton,
                  voiceModelActionBlocked && styles.disabledButton,
                ]}
                onPress={() => void handleTestVoiceModel()}
                disabled={voiceModelActionBlocked}
              >
                <Text style={styles.buttonText}>
                  {voiceRuntimePending
                    ? 'Checking…'
                    : isTestingVoiceAsr
                      ? 'Testing…'
                      : 'Test Model'}
                </Text>
              </Pressable>
            ) : null}
            {voiceModelState?.status !== 'not_downloaded' &&
            voiceModelState?.source !== 'configured' ? (
              <Pressable
                style={[
                  styles.button,
                  styles.dangerButton,
                  styles.compactButton,
                  isResettingVoiceModel && styles.disabledButton,
                ]}
                onPress={() => void handleResetVoiceModel()}
                disabled={isDownloadingVoiceModel || isResettingVoiceModel}
              >
                <Text style={styles.buttonText}>
                  {isResettingVoiceModel ? 'Resetting…' : 'Reset Model'}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {voiceModelSelectionLocked ? (
            <Text style={styles.helperText}>
              Model selection is locked by EXPO_PUBLIC_SHERPA_ASR_MODEL_DIR / MODEL_ID.
            </Text>
          ) : null}
        </View>
      ) : null}

      {showProfileAuthSetup ? (
        <>
          <View style={styles.infoSection}>
            <Text style={styles.sectionTitle}>Profile Auth</Text>
            <Text style={styles.helperText}>
              Credentials are stored in SecureStore. Use token/password auth when the gateway is
              exposed through WSS or a port forward.
            </Text>
            <View style={styles.modeRow}>
              {(['none', 'token', 'password'] as const).map((mode) => (
                <Pressable
                  key={mode}
                  style={[styles.modeChip, authMode === mode && styles.modeChipActive]}
                  onPress={() => setAuthMode(mode)}
                >
                  <Text style={[styles.modeText, authMode === mode && styles.modeTextActive]}>
                    {mode}
                  </Text>
                </Pressable>
              ))}
            </View>
            {authMode !== 'none' ? (
              <View style={styles.field}>
                <Text style={styles.label}>{authMode === 'token' ? 'Token' : 'Password'}</Text>
                <TextInput
                  style={styles.input}
                  value={authSecret}
                  onChangeText={setAuthSecret}
                  placeholder={`Gateway ${authMode}`}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
              </View>
            ) : null}
            <Pressable style={styles.button} onPress={handleSaveAuth}>
              <Text style={styles.buttonText}>Save Auth for Active Profile</Text>
            </Pressable>
          </View>

          <View style={styles.infoSection}>
            <Text style={styles.sectionTitle}>Add Profile</Text>
            <View style={styles.field}>
              <Text style={styles.label}>Profile name</Text>
              <TextInput
                style={styles.input}
                value={profileName}
                onChangeText={setProfileName}
                placeholder="Cloudflare / remote"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="words"
              />
            </View>
            <View style={styles.modeRow}>
              {(['remote', 'tailnet', 'custom', 'lan'] as const).map((kind) => (
                <Pressable
                  key={kind}
                  style={[styles.modeChip, profileKind === kind && styles.modeChipActive]}
                  onPress={() => setProfileKind(kind)}
                >
                  <Text style={[styles.modeText, profileKind === kind && styles.modeTextActive]}>
                    {kind}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={styles.button} onPress={handleAddProfile}>
              <Text style={styles.buttonText}>Add Profile from URL</Text>
            </Pressable>
            <Text style={styles.helperText}>
              LAN and tailnet profiles can use ws:// on trusted private networks. Remote profiles
              require wss://; TLS termination can be handled by your port-forward/proxy setup.
            </Text>
          </View>
        </>
      ) : null}

      <View style={styles.infoSection}>
        <Text style={styles.sectionTitle}>Terminal</Text>
        <Text style={[baseStyles.textMuted, { marginBottom: spacing.sm }]}>
          tmux prefix used by the terminal control bar (Prev win, Next win, Split, etc.). Pick the
          binding configured on your gateway machines.
        </Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {(['C-a', 'C-b'] as TmuxPrefixOption[]).map((option) => {
            const active = tmuxPrefix === option;
            return (
              <Pressable
                key={option}
                onPress={() => setTmuxPrefix(option)}
                style={{
                  backgroundColor: active ? colors.accent : colors.bgCard,
                  borderColor: active ? colors.accent : colors.bgSurface,
                  borderRadius: radii.lg,
                  borderWidth: 1,
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                }}
              >
                <Text
                  style={{
                    color: active ? colors.bgBase : colors.textPrimary,
                    fontFamily: fonts.mono,
                    fontWeight: '600',
                  }}
                >
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {!isStoreScreenshotMode ? (
        <View style={styles.infoSection}>
          <View style={styles.diagnosticsHeader}>
            <View style={styles.diagnosticsCopy}>
              <Text style={[styles.sectionTitle, styles.diagnosticsTitle]}>
                Advanced diagnostics
              </Text>
              <Text style={styles.helperTextNoMargin}>
                Environment, update status, and raw troubleshooting live here so pairing stays first.
              </Text>
            </View>
            <Pressable
              style={styles.advancedToggle}
              onPress={() => setDiagnosticsOpen((open) => !open)}
            >
              <Text style={styles.advancedToggleText}>
                {diagnosticsOpen ? 'Hide' : 'Show'}
              </Text>
            </Pressable>
          </View>
          {diagnosticsOpen ? (
            <View style={styles.diagnosticsCards}>
              <AppEnvironmentCard />
              <AppUpdateStatusCard />
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.infoSection}>
        <Text style={styles.sectionTitle}>About</Text>
        <Text style={baseStyles.textSecondary}>
          Farmslot keeps the fleet observable from your phone and tablet.
        </Text>
        <Text style={styles.aboutCredit}>Built by Arthur Breton · Siteed</Text>
        <View style={styles.aboutLinks}>
          <Pressable
            style={styles.aboutLink}
            onPress={() => void handleOpenExternalUrl(FARMSLOT_PROJECT_URL)}
          >
            <Text style={styles.aboutLinkText}>farmslot.io</Text>
          </Pressable>
          <Pressable
            style={styles.aboutLink}
            onPress={() => void handleOpenExternalUrl(FARMSLOT_PRIVACY_URL)}
          >
            <Text style={styles.aboutLinkText}>Privacy Policy</Text>
          </Pressable>
        </View>
      </View>

      <Modal
        visible={pairingScannerOpen}
        animationType="slide"
        onRequestClose={() => setPairingScannerOpen(false)}
      >
        <SafeAreaView style={styles.scannerContainer}>
          <CameraView
            style={styles.scanner}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={pairingInProgress ? undefined : handlePairingBarcodeScanned}
          />
          <View style={[styles.scannerOverlay, { paddingBottom: spacing.xl + insets.bottom }]}>
            <Text style={styles.scannerTitle}>Scan Farmslot pairing QR</Text>
            <Text style={styles.scannerHelp}>
              Command Center → connection status → Generate QR. Keep this screen open until pairing
              completes.
            </Text>
            {pairingInProgress ? (
              <View style={styles.scannerProgress}>
                <ActivityIndicator color="#fff" />
                <Text style={styles.scannerHelp}>Exchanging credential…</Text>
              </View>
            ) : null}
            <Pressable
              style={[styles.button, styles.scannerCancelButton]}
              onPress={() => setPairingScannerOpen(false)}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.xl,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '600',
    marginBottom: spacing.lg,
  },
  field: {
    marginBottom: spacing.lg,
  },
  label: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.bgInput,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.bgCard,
  },
  profileList: {
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  emptyProfileCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgSurface,
    borderRadius: radii.md,
    borderStyle: 'dashed',
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  profileCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.bgCard,
  },
  profileCardActive: {
    borderColor: colors.accent,
  },
  profileButton: {
    padding: spacing.lg,
  },
  profileHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  profileName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '600',
  },
  profileBadge: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    textTransform: 'uppercase',
  },
  profileBadgeActive: {
    color: colors.statusOk,
  },
  profileUrl: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
  },
  profileAuth: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  profileActions: {
    borderTopWidth: 1,
    borderTopColor: colors.bgSurface,
    flexDirection: 'row',
  },
  profileActionButton: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  profileActionButtonActive: {
    backgroundColor: colors.accent + '18',
  },
  profileActionButtonText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  profileActionButtonTextActive: {
    color: colors.statusOk,
  },
  profileTestButton: {
    borderLeftWidth: 1,
    borderLeftColor: colors.bgSurface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  deleteButton: {
    borderLeftWidth: 1,
    borderLeftColor: colors.bgSurface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  deleteText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
  },
  buttonRow: {
    gap: spacing.md,
    marginBottom: spacing.xxl,
  },
  buttonRowCompact: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  modeChip: {
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  modeChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  modeText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  modeTextActive: {
    color: '#fff',
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.lg,
    borderRadius: radii.md,
    alignItems: 'center',
  },
  secondaryButton: {
    backgroundColor: colors.bgCardHover,
  },
  dangerButton: {
    backgroundColor: colors.statusFail + '33',
    borderColor: colors.statusFail + '70',
    borderWidth: 1,
  },
  disabledButton: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: fonts.sizeMd,
    fontWeight: '600',
  },
  compactButton: {
    flex: 1,
    minWidth: 140,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  connectionTestText: {
    fontSize: fonts.sizeSm,
    lineHeight: 18,
    marginBottom: spacing.lg,
    marginTop: -spacing.lg,
  },
  connectionTestInline: {
    marginTop: -spacing.md,
  },
  connectionTestOk: {
    color: colors.statusOk,
  },
  connectionTestFailed: {
    color: colors.statusFail,
  },
  helperText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
    marginTop: spacing.md,
  },
  helperTextNoMargin: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  gatewayActionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  gatewayActionCopy: {
    flex: 1,
    minWidth: 0,
  },
  gatewayActionTitle: {
    marginBottom: spacing.xs,
  },
  pairingImportText: {
    color: colors.statusOk,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
    marginTop: spacing.md,
  },
  advancedToggle: {
    alignItems: 'center',
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingVertical: spacing.md,
  },
  advancedToggleText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  statusValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  requiredSetupCard: {
    alignItems: 'center',
    backgroundColor: colors.statusWarn + '14',
    borderColor: colors.statusWarn + '88',
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xl,
    padding: spacing.md,
  },
  requiredSetupCopy: {
    flex: 1,
    minWidth: 0,
  },
  requiredSetupEyebrow: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  requiredSetupTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  requiredSetupText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
  requiredSetupButton: {
    flex: 0,
  },
  voicePermissionCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  voicePermissionCardNeedsAction: {
    backgroundColor: colors.statusWarn + '14',
    borderColor: colors.statusWarn + '88',
  },
  voicePermissionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  voicePermissionTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  voicePermissionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  voicePermissionText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  voicePermissionMessage: {
    fontSize: fonts.sizeXs,
  },
  voiceModelChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  voiceModelChoice: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    flex: 1,
    minWidth: 150,
    padding: spacing.md,
  },
  voiceModelChoiceActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  voiceModelName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  voiceModelNameActive: {
    color: colors.accent,
  },
  voiceModelMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
    marginTop: spacing.xs,
  },
  voiceSectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  voiceSectionTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  voiceSectionTitle: {
    marginBottom: spacing.xs,
  },
  voiceSectionSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  voiceStatusPill: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  voiceStatusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  voiceStatusText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  voiceModelStatusCard: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    marginTop: spacing.lg,
    padding: spacing.lg,
  },
  voiceModelStatusTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  voiceModelStatusText: {
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  voiceRuntimeText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
    marginTop: spacing.sm,
  },
  voiceModelProgressTrack: {
    backgroundColor: colors.bgCard,
    borderRadius: 999,
    height: 6,
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  voiceModelProgressFill: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    height: '100%',
  },
  aboutCredit: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
    marginTop: spacing.md,
  },
  aboutLinks: {
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  aboutLink: {
    paddingVertical: spacing.xs,
  },
  aboutLinkText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
  },
  infoSection: {
    marginTop: spacing.xxl,
    paddingTop: spacing.xxl,
    borderTopWidth: 1,
    borderTopColor: colors.bgCard,
  },
  diagnosticsHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  diagnosticsCopy: {
    flex: 1,
    minWidth: 0,
  },
  diagnosticsTitle: {
    marginBottom: spacing.sm,
  },
  diagnosticsCards: {
    gap: spacing.lg,
    marginTop: spacing.lg,
  },
  scannerContainer: {
    backgroundColor: '#000',
    flex: 1,
  },
  scanner: {
    flex: 1,
  },
  scannerOverlay: {
    backgroundColor: 'rgba(0,0,0,0.72)',
    bottom: 0,
    left: 0,
    padding: spacing.xl,
    position: 'absolute',
    right: 0,
  },
  scannerTitle: {
    color: '#fff',
    fontSize: fonts.sizeLg,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  scannerHelp: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  scannerProgress: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  scannerCancelButton: {
    marginTop: spacing.xl,
  },
});

type ImportedPairingProfile = {
  profile: GatewayProfile;
  secret: string;
};

type PairingProfileReachability = {
  profile: GatewayProfile;
  reachable: boolean;
  error?: string;
};

const PAIRING_PROFILE_TEST_TIMEOUT_MS = 3_500;

function mergeVisibleProfiles(
  profiles: GatewayProfile[],
  recentImportedProfiles: GatewayProfile[],
): GatewayProfile[] {
  const byId = new Map<string, GatewayProfile>();
  for (const profile of recentImportedProfiles) byId.set(profile.id, profile);
  for (const profile of profiles) byId.set(profile.id, profile);
  return [...byId.values()];
}

async function testImportedPairingProfiles(
  importedProfiles: ImportedPairingProfile[],
): Promise<PairingProfileReachability[]> {
  return Promise.all(
    importedProfiles.map(async (importedProfile) => {
      const auth = authCredentialsForSecret(importedProfile.profile, importedProfile.secret);
      try {
        await testGatewayConnection(
          importedProfile.profile.url,
          auth,
          PAIRING_PROFILE_TEST_TIMEOUT_MS,
        );
        return { profile: importedProfile.profile, reachable: true };
      } catch (error) {
        // Pairing commonly contains LAN + remote URLs; at least one can be unreachable
        // from the current network. Capture the failure so the UI can guide selection.
        return {
          profile: importedProfile.profile,
          reachable: false,
          error: (error as Error).message,
        };
      }
    }),
  );
}

function firstPairingReachabilityError(reachability: PairingProfileReachability[]): string {
  const firstError = reachability.find((candidate) => candidate.error);
  return firstError
    ? `Imported profiles, but ${firstError.profile.name} did not connect: ${firstError.error}`
    : 'Imported profiles, but none connected from this device yet.';
}

function authCredentialsForSecret(profile: GatewayProfile, secret: string): GatewayAuthCredentials {
  if (profile.authMode === 'token') return { token: secret };
  if (profile.authMode === 'password') return { password: secret };
  return {};
}

async function authCredentialsForProfile(profile: GatewayProfile): Promise<GatewayAuthCredentials> {
  if (profile.authMode === 'token') {
    const token = await readGatewayProfileSecret(profile);
    return token ? { token } : {};
  }
  if (profile.authMode === 'password') {
    const password = await readGatewayProfileSecret(profile);
    return password ? { password } : {};
  }
  return {};
}
