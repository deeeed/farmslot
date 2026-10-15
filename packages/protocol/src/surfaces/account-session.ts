import type { PersonDeviceSession } from '../rpc/auth.js';

/** Shared account control for Command Center and Companion. Local sign-out never revokes a credential. */
export const ACCOUNT_SESSION_CONTROL = {
  label: 'Sign out / switch account',
  signedOut: 'Signed out. Log in or pair to choose an account.',
  description: 'Forget this device login and disconnect. Other devices stay connected.',
} as const;

export interface AccountSignOutActions {
  forgetLogin: () => Promise<void>;
  closeSession: () => void;
}

/** Persist first. If storage fails the caller shows the failure and keeps the current session. */
export async function signOutAccount(actions: AccountSignOutActions): Promise<void> {
  await actions.forgetLogin();
  actions.closeSession();
}

export function personSessionCaption(session: PersonDeviceSession | null | undefined): string {
  return session
    ? `Signed in on ${session.deviceName} until ${new Date(session.refreshExpiresAt).toLocaleDateString()}`
    : '';
}
