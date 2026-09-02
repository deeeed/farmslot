import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

export const ATTENTION_PREFS_STORAGE_KEY = '@farmslot:attentionPrefs';

export interface AttentionPrefs {
  enabled: boolean;
  sound: boolean;
  haptics: boolean;
}

interface AttentionPrefsStore extends AttentionPrefs {
  initialized: boolean;
  init: () => Promise<void>;
  setEnabled: (value: boolean) => void;
  setSound: (value: boolean) => void;
  setHaptics: (value: boolean) => void;
}

export function normalizeAttentionPrefs(value: unknown): AttentionPrefs {
  if (!value || typeof value !== 'object') return { enabled: true, sound: true, haptics: true };
  const candidate = value as Partial<AttentionPrefs>;
  return {
    enabled: candidate.enabled !== false,
    sound: candidate.sound !== false,
    haptics: candidate.haptics !== false,
  };
}

function persist(state: AttentionPrefs): void {
  void AsyncStorage.setItem(ATTENTION_PREFS_STORAGE_KEY, JSON.stringify(state));
}

export const useAttentionPrefsStore = create<AttentionPrefsStore>((set, get) => ({
  ...normalizeAttentionPrefs(null),
  initialized: false,
  init: async () => {
    if (get().initialized) return;
    try {
      const raw = await AsyncStorage.getItem(ATTENTION_PREFS_STORAGE_KEY);
      set({ ...normalizeAttentionPrefs(raw ? JSON.parse(raw) : null), initialized: true });
    } catch (error) {
      console.warn('[attention-prefs] failed to read stored preferences:', error);
      set({ initialized: true });
    }
  },
  setEnabled: (enabled) => {
    set({ enabled });
    persist({ ...get(), enabled });
  },
  setSound: (sound) => {
    set({ sound });
    persist({ ...get(), sound });
  },
  setHaptics: (haptics) => {
    set({ haptics });
    persist({ ...get(), haptics });
  },
}));
