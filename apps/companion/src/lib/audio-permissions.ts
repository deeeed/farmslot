import { AudioStudioModule } from '@siteed/audio-studio';

import { microphonePermissionIsBlocked } from './audio-permission-state';

export type MicrophonePermissionState = {
  status: string;
  granted: boolean;
  canAskAgain?: boolean;
};

export type MicrophonePermissionGateResult =
  | {
      granted: true;
      permission: MicrophonePermissionState;
    }
  | {
      granted: false;
      blocked: boolean;
      message: string;
      permission: MicrophonePermissionState;
    };

export async function getMicrophonePermissionState(): Promise<MicrophonePermissionState> {
  return (await AudioStudioModule.getPermissionsAsync()) as MicrophonePermissionState;
}

export async function requestMicrophonePermissionState(): Promise<MicrophonePermissionState> {
  return (await AudioStudioModule.requestPermissionsAsync()) as MicrophonePermissionState;
}

export async function ensureMicrophonePermission(): Promise<MicrophonePermissionGateResult> {
  const currentPermission = await getMicrophonePermissionState();
  if (currentPermission.granted) {
    return { granted: true, permission: currentPermission };
  }

  if (microphonePermissionIsBlocked(currentPermission)) {
    return blockedMicrophonePermission(currentPermission);
  }

  const requestedPermission = await requestMicrophonePermissionState();
  if (requestedPermission.granted) {
    return { granted: true, permission: requestedPermission };
  }

  if (microphonePermissionIsBlocked(requestedPermission)) {
    return blockedMicrophonePermission(requestedPermission);
  }

  return {
    granted: false,
    blocked: false,
    message: 'Microphone access is required before voice mode can record instructions.',
    permission: requestedPermission,
  };
}

function blockedMicrophonePermission(
  permission: MicrophonePermissionState,
): MicrophonePermissionGateResult {
  return {
    granted: false,
    blocked: true,
    message:
      'Microphone access is blocked. Open Settings and enable Microphone for Farmslot before using voice mode.',
    permission,
  };
}
