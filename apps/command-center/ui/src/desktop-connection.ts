import {
  parsePersonSessionToken,
  type PersonSessionAuth,
  PersonSessionChangedError,
} from '@farmslot/protocol';

/** Narrow API exposed by the Electron preload. No Node APIs enter the renderer. */
export interface DesktopConnection {
  url: string;
  token?: string;
  password?: string;
  rememberMe?: boolean;
  personSession?: PersonSessionAuth | null;
  pending?: boolean;
}

export interface FarmslotDesktopBridge {
  loadConnection(): Promise<DesktopConnection | null>;
  saveConnection(connection: DesktopConnection): Promise<void>;
  copyCurrentLink?(): Promise<string>;
  updateAttention?(value: { connected: boolean; ready: boolean; decisions: number }): Promise<void>;
  onResume(callback: () => void): () => void;
}

declare global {
  interface Window {
    farmslotDesktop?: FarmslotDesktopBridge;
  }
}

let connection: DesktopConnection | null = null;
let saving: Promise<void> | null = null;

export function isDesktopClient(): boolean {
  return typeof window !== 'undefined' && Boolean(window.farmslotDesktop);
}

export async function initializeDesktopConnection(): Promise<void> {
  connection = null;
  if (!isDesktopClient()) return;
  connection = await window.farmslotDesktop!.loadConnection();
  if (!connection) throw new Error('Choose a gateway in connection settings.');
}

export function getDesktopConnection(): DesktopConnection | null {
  return isDesktopClient() ? connection : null;
}

/** Persist first so a Keychain failure leaves the current connection usable. */
export async function saveDesktopCredentials(
  auth: {
    token?: string;
    password?: string;
    personSession?: PersonSessionAuth | null;
  },
  rememberMe?: boolean,
  pending = false,
): Promise<void> {
  if (!isDesktopClient()) return;
  if (!connection) throw new Error('Desktop connection has not been initialized.');
  if (auth.token && parsePersonSessionToken(auth.token, 'fsa'))
    throw new Error(
      'Access tokens cannot be saved. Sign in with a person credential or pairing code.',
    );
  const expected = connection;
  if (saving) await saving;
  if (connection !== expected) throw new PersonSessionChangedError();
  const updated = {
    url: connection.url,
    rememberMe: rememberMe ?? connection.rememberMe ?? true,
    ...auth,
    ...(pending ? { pending: true } : {}),
  };
  const task = window.farmslotDesktop!.saveConnection(updated);
  saving = task;
  try {
    await task;
    if (connection !== expected) throw new PersonSessionChangedError();
    connection = updated;
  } finally {
    if (saving === task) saving = null;
  }
}
