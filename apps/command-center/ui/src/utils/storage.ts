// Safe localStorage accessors. Sandboxed/private-mode browsers can expose
// the global but throw on access — call sites need to degrade to defaults
// rather than crash app bootstrap or lifecycle hooks.

export function safeLsGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeLsSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeLsRemove(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    /* sandboxed — already lost, nothing to clean up */
  }
}
