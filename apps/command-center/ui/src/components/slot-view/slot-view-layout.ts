const LEGACY_LAYOUT_KEY = 'farmslot:slot-view-layout';
const LAYOUT_PREFS_KEY = 'farmslot:slot-view-prefs:v2';

export interface LayoutPrefs {
  sidebarWidth: number;
  terminalHeight: number;
  pinnedHeight?: number;
  terminalOpen: boolean;
  sidebarOpen: boolean;
  sections: Record<string, boolean>;
  activity?: string;
  streamWidth?: number;
  reviewPanelWidth?: number;
  selectedAgentContextId?: string;
  selectedAgentContextIds?: Record<string, string>;
}

export function loadLayout(): Partial<LayoutPrefs> {
  try {
    const current = localStorage.getItem(LAYOUT_PREFS_KEY);
    if (current) return JSON.parse(current);
    const legacyRaw = localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (!legacyRaw) return {};
    const legacy = JSON.parse(legacyRaw) as Partial<LayoutPrefs> & Record<string, unknown>;
    const migrated: Partial<LayoutPrefs> = {
      ...(typeof legacy.sidebarWidth === 'number' ? { sidebarWidth: legacy.sidebarWidth } : {}),
      ...(typeof legacy.terminalHeight === 'number'
        ? { terminalHeight: legacy.terminalHeight }
        : {}),
      ...(typeof legacy.pinnedHeight === 'number' ? { pinnedHeight: legacy.pinnedHeight } : {}),
      ...(typeof legacy.terminalOpen === 'boolean' ? { terminalOpen: legacy.terminalOpen } : {}),
      ...(typeof legacy.sidebarOpen === 'boolean' ? { sidebarOpen: legacy.sidebarOpen } : {}),
      ...(legacy.sections && typeof legacy.sections === 'object'
        ? { sections: legacy.sections as Record<string, boolean> }
        : {}),
      ...(typeof legacy.activity === 'string' ? { activity: legacy.activity } : {}),
      ...(typeof legacy.streamWidth === 'number' ? { streamWidth: legacy.streamWidth } : {}),
      ...(typeof legacy.reviewPanelWidth === 'number'
        ? { reviewPanelWidth: legacy.reviewPanelWidth }
        : {}),
      ...(typeof legacy.selectedAgentContextId === 'string'
        ? { selectedAgentContextId: legacy.selectedAgentContextId }
        : {}),
      ...(legacy.selectedAgentContextIds && typeof legacy.selectedAgentContextIds === 'object'
        ? { selectedAgentContextIds: legacy.selectedAgentContextIds as Record<string, string> }
        : {}),
    };
    localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify(migrated));
    localStorage.removeItem(LEGACY_LAYOUT_KEY);
    return migrated;
  } catch (err) {
    // Layout preferences are user-local cache data; malformed legacy values should not block the slot view.
    console.warn(
      '[slot-view] layout migration failed:',
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}

export function saveLayout(prefs: LayoutPrefs) {
  localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify(prefs));
}
