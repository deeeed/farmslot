import { armLocalWorkspace } from '@farmslot/capabilities/workspace-watch';
interface WatchArm {
  stop?: () => void;
  cancelled: boolean;
}
const watches = new Map<string, WatchArm>();
export async function startWorkspaceWatch(
  id: string,
  root: string,
  changed: () => void,
  failed: (error: Error) => void,
): Promise<void> {
  stopWorkspaceWatch(id);
  const arm: WatchArm = { cancelled: false };
  watches.set(id, arm);
  const current = () => watches.get(id) === arm && !arm.cancelled;
  try {
    const stop = await armLocalWorkspace(
      root,
      () => {
        if (current()) changed();
      },
      (error) => {
        if (!current()) return;
        stopWorkspaceWatch(id);
        failed(error);
      },
    );
    if (!current()) {
      stop();
      throw new Error('Workspace arm revoked before admission');
    } else arm.stop = stop;
  } catch (error) {
    if (current()) stopWorkspaceWatch(id);
    throw error;
  }
}
export function stopWorkspaceWatch(id: string): boolean {
  const arm = watches.get(id);
  if (!arm) return false;
  watches.delete(id);
  arm.cancelled = true;
  arm.stop?.();
  return true;
}
export function stopAllWorkspaceWatches(): void {
  for (const id of watches.keys()) stopWorkspaceWatch(id);
}
