export type MicrophonePermissionSnapshot = {
  status?: string;
  granted: boolean;
  canAskAgain?: boolean;
};

export type MicrophonePermissionSetupStatus = 'checking' | 'ready' | 'blocked' | 'required';

export type MicrophonePermissionSetupState = {
  status: MicrophonePermissionSetupStatus;
  label: string;
  title: string;
  body: string;
  message: string;
  actionLabel: string | null;
  needsAction: boolean;
  blocked: boolean;
};

export function microphonePermissionIsBlocked(permission: MicrophonePermissionSnapshot): boolean {
  if (permission.granted) return false;
  if (permission.canAskAgain === false) return true;
  return permission.status?.toLowerCase() === 'denied' && permission.canAskAgain !== true;
}

export function microphonePermissionSetupState(
  permission: MicrophonePermissionSnapshot | null,
): MicrophonePermissionSetupState {
  if (!permission) {
    return {
      status: 'checking',
      label: 'checking',
      title: 'Checking microphone access',
      body: 'Voice mode needs microphone access before it can record instructions.',
      message: 'Checking microphone permission for voice mode.',
      actionLabel: null,
      needsAction: true,
      blocked: false,
    };
  }

  if (permission.granted) {
    return {
      status: 'ready',
      label: 'allowed',
      title: 'Microphone ready',
      body: 'Voice mode can record and locally transcribe worker instructions.',
      message: 'Microphone is enabled for voice Co-Pilot recording.',
      actionLabel: null,
      needsAction: false,
      blocked: false,
    };
  }

  if (microphonePermissionIsBlocked(permission)) {
    return {
      status: 'blocked',
      label: 'blocked',
      title: 'Microphone blocked in system settings',
      body: 'You skipped or blocked the permission prompt. Open system settings and allow Microphone for Farmslot before using voice mode.',
      message:
        'Microphone is blocked. Open system settings and allow microphone access for Farmslot.',
      actionLabel: 'Open App Settings',
      needsAction: true,
      blocked: true,
    };
  }

  return {
    status: 'required',
    label: permission.status || 'not allowed',
    title: 'Microphone permission required',
    body: 'Allow microphone access now so voice mode can record and transcribe instructions.',
    message: 'Microphone access is required before voice mode can record instructions.',
    actionLabel: 'Allow Microphone',
    needsAction: true,
    blocked: false,
  };
}
