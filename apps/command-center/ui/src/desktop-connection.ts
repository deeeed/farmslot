/** Narrow API exposed by the Electron preload. No Node APIs enter the renderer. */
export interface DesktopConnection {
  url: string;
  token?: string;
  password?: string;
  rememberMe?: boolean;
}

export interface FarmslotDesktopBridge {
  loadConnection(): Promise<DesktopConnection | null>;
  saveConnection(connection: DesktopConnection): Promise<void>;
  updateAttention?(value: { connected: boolean; ready: boolean; decisions: number }): Promise<void>;
  onResume(callback: () => void): () => void;
}

declare global {
  interface Window {
    farmslotDesktop?: FarmslotDesktopBridge;
  }
}

let connection: DesktopConnection | null = null;

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
  },
  rememberMe?: boolean,
): Promise<void> {
  if (!isDesktopClient()) return;
  if (!connection) throw new Error('Desktop connection has not been initialized.');
  const updated = {
    url: connection.url,
    rememberMe: rememberMe ?? connection.rememberMe ?? true,
    ...auth,
  };
  await window.farmslotDesktop!.saveConnection(updated);
  connection = updated;
}
