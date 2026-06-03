import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

export type TmuxPrefixOption = 'C-a' | 'C-b';

export const TERMINAL_PREFS_STORAGE_KEY = '@farmslot:terminalPrefs';

export const TMUX_PREFIX_BYTES: Record<TmuxPrefixOption, string> = {
  'C-a': '\x01',
  'C-b': '\x02',
};

// Common tmux configs often bind prefix to Ctrl-A, so default the
// companion's tmux controls to match — users on stock C-b can flip in settings.
const DEFAULT_PREFIX: TmuxPrefixOption = 'C-a';

interface TerminalPrefsStore {
  allowTerminalTouchKeyboard: boolean;
  tmuxPrefix: TmuxPrefixOption;
  initialized: boolean;
  init: () => Promise<void>;
  setAllowTerminalTouchKeyboard: (value: boolean) => void;
  setTmuxPrefix: (value: TmuxPrefixOption) => void;
}

function isTmuxPrefixOption(value: unknown): value is TmuxPrefixOption {
  return value === 'C-a' || value === 'C-b';
}

function persistedTerminalPrefs(
  state: Pick<TerminalPrefsStore, 'allowTerminalTouchKeyboard' | 'tmuxPrefix'>,
) {
  return JSON.stringify({
    allowTerminalTouchKeyboard: state.allowTerminalTouchKeyboard,
    tmuxPrefix: state.tmuxPrefix,
  });
}

export const useTerminalPrefsStore = create<TerminalPrefsStore>((set, get) => ({
  allowTerminalTouchKeyboard: false,
  tmuxPrefix: DEFAULT_PREFIX,
  initialized: false,
  init: async () => {
    if (get().initialized) return;
    try {
      const raw = await AsyncStorage.getItem(TERMINAL_PREFS_STORAGE_KEY);
      const parsed = raw
        ? (JSON.parse(raw) as { allowTerminalTouchKeyboard?: unknown; tmuxPrefix?: unknown } | null)
        : null;
      const allowTerminalTouchKeyboard = parsed?.allowTerminalTouchKeyboard === true;
      const tmuxPrefix = isTmuxPrefixOption(parsed?.tmuxPrefix)
        ? parsed.tmuxPrefix
        : DEFAULT_PREFIX;
      set({ allowTerminalTouchKeyboard, tmuxPrefix, initialized: true });
    } catch {
      // Dev builds can carry malformed storage payloads; falling back to the
      // default keeps tmux controls usable while the user re-picks a prefix.
      set({ initialized: true });
    }
  },
  setAllowTerminalTouchKeyboard: (value) => {
    set({ allowTerminalTouchKeyboard: value });
    void AsyncStorage.setItem(
      TERMINAL_PREFS_STORAGE_KEY,
      persistedTerminalPrefs({ ...get(), allowTerminalTouchKeyboard: value }),
    );
  },
  setTmuxPrefix: (value) => {
    set({ tmuxPrefix: value });
    void AsyncStorage.setItem(
      TERMINAL_PREFS_STORAGE_KEY,
      persistedTerminalPrefs({ ...get(), tmuxPrefix: value }),
    );
  },
}));
