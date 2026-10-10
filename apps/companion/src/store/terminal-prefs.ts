import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import {
  addTerminalCustomKey,
  normalizeRunnerKeyOverrides,
  normalizeTerminalCustomKeys,
  removeTerminalCustomKey,
  type RunnerKeyOverrides,
  type TerminalCustomKey,
} from '../lib/terminal-controls';

export type TmuxPrefixOption = 'C-a' | 'C-b';

export const TERMINAL_PREFS_STORAGE_KEY = '@farmslot:terminalPrefs';

export const TMUX_PREFIX_BYTES: Record<TmuxPrefixOption, string> = {
  'C-a': '\x01',
  'C-b': '\x02',
};

// Common tmux configs often bind prefix to Ctrl-A, so default the
// companion's tmux controls to match — users on stock C-b can flip in settings.
const DEFAULT_PREFIX: TmuxPrefixOption = 'C-a';

export interface TerminalPrefs {
  allowTerminalTouchKeyboard: boolean;
  tmuxPrefix: TmuxPrefixOption;
  /** Device-level keys shown in the Yours row of every terminal. */
  customKeys: TerminalCustomKey[];
  /** Runner key profile picked for a pane, keyed by node id plus tmux target. */
  runnerKeyOverrides: RunnerKeyOverrides;
}

interface TerminalPrefsStore extends TerminalPrefs {
  initialized: boolean;
  init: () => Promise<void>;
  setAllowTerminalTouchKeyboard: (value: boolean) => void;
  setTmuxPrefix: (value: TmuxPrefixOption) => void;
  /** Returns the validation error, or null once the key is saved. */
  addCustomKey: (draft: TerminalCustomKey) => string | null;
  deleteCustomKey: (label: string) => void;
  /** `null` clears the override so the pane returns to auto detection. */
  setRunnerKeyOverride: (paneKey: string, runnerId: string | null) => void;
}

function isTmuxPrefixOption(value: unknown): value is TmuxPrefixOption {
  return value === 'C-a' || value === 'C-b';
}

export function parseTerminalPrefs(raw: string | null): TerminalPrefs {
  const parsed = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
  return {
    allowTerminalTouchKeyboard: parsed?.allowTerminalTouchKeyboard === true,
    tmuxPrefix: isTmuxPrefixOption(parsed?.tmuxPrefix) ? parsed.tmuxPrefix : DEFAULT_PREFIX,
    customKeys: normalizeTerminalCustomKeys(parsed?.customKeys),
    runnerKeyOverrides: normalizeRunnerKeyOverrides(parsed?.runnerKeyOverrides),
  };
}

export function serializeTerminalPrefs(prefs: TerminalPrefs): string {
  return JSON.stringify({
    allowTerminalTouchKeyboard: prefs.allowTerminalTouchKeyboard,
    tmuxPrefix: prefs.tmuxPrefix,
    customKeys: prefs.customKeys,
    runnerKeyOverrides: prefs.runnerKeyOverrides,
  });
}

export const useTerminalPrefsStore = create<TerminalPrefsStore>((set, get) => {
  const update = (patch: Partial<TerminalPrefs>) => {
    set(patch);
    void AsyncStorage.setItem(TERMINAL_PREFS_STORAGE_KEY, serializeTerminalPrefs(get()));
  };
  return {
    ...parseTerminalPrefs(null),
    initialized: false,
    init: async () => {
      if (get().initialized) return;
      try {
        const raw = await AsyncStorage.getItem(TERMINAL_PREFS_STORAGE_KEY);
        set({ ...parseTerminalPrefs(raw), initialized: true });
      } catch {
        // Dev builds can carry malformed storage payloads; falling back to the
        // default keeps tmux controls usable while the user re-picks a prefix.
        set({ initialized: true });
      }
    },
    setAllowTerminalTouchKeyboard: (value) => update({ allowTerminalTouchKeyboard: value }),
    setTmuxPrefix: (value) => update({ tmuxPrefix: value }),
    addCustomKey: (draft) => {
      const result = addTerminalCustomKey(get().customKeys, draft);
      if (!result.ok) return result.error;
      update({ customKeys: result.keys });
      return null;
    },
    deleteCustomKey: (label) =>
      update({ customKeys: removeTerminalCustomKey(get().customKeys, label) }),
    setRunnerKeyOverride: (paneKey, runnerId) => {
      const runnerKeyOverrides = { ...get().runnerKeyOverrides };
      delete runnerKeyOverrides[paneKey];
      if (runnerId) runnerKeyOverrides[paneKey] = runnerId;
      update({ runnerKeyOverrides });
    },
  };
});
