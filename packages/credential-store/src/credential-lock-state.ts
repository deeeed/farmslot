const heldCredentialStoreLocks = new Set<string>();

export function markCredentialStoreLockHeld(path: string): void {
  heldCredentialStoreLocks.add(path);
}

export function markCredentialStoreLockReleased(path: string): void {
  heldCredentialStoreLocks.delete(path);
}

export function isCredentialStoreLockHeld(path: string): boolean {
  return heldCredentialStoreLocks.has(path);
}
