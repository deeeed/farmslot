// Browser Notification API wrapper for farmslot alerts

let permissionGranted = false;
const ATTENTION_PREFS_KEY = 'farmslot-attention-alerts';
export const ATTENTION_ALERT_EVENT = 'farmslot-attention-alert';

export interface AttentionAlertDetail {
  title: string;
  body?: string;
  route?: string;
}

export interface AttentionAlertPreferences {
  attentionEnabled: boolean;
  sound: boolean;
  backgroundNotifications: boolean;
}

const DEFAULT_ATTENTION_PREFS: AttentionAlertPreferences = {
  attentionEnabled: true,
  sound: true,
  backgroundNotifications: true,
};

const SUPPRESS_MS = 5_000; // suppress duplicate triggers within 5s
const recentTags = new Map<string, number>();

export function normalizeAttentionAlertPreferences(value: unknown): AttentionAlertPreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_ATTENTION_PREFS };
  const candidate = value as Partial<AttentionAlertPreferences>;
  return {
    attentionEnabled: candidate.attentionEnabled !== false,
    sound: candidate.sound !== false,
    backgroundNotifications: candidate.backgroundNotifications !== false,
  };
}

export function getAttentionAlertPreferences(): AttentionAlertPreferences {
  try {
    const raw = localStorage.getItem(ATTENTION_PREFS_KEY);
    return normalizeAttentionAlertPreferences(raw ? JSON.parse(raw) : null);
  } catch (error) {
    console.warn('[notifications] failed to read attention preferences:', error);
    return { ...DEFAULT_ATTENTION_PREFS };
  }
}

export function setAttentionAlertPreferences(preferences: AttentionAlertPreferences): void {
  localStorage.setItem(ATTENTION_PREFS_KEY, JSON.stringify(preferences));
}

function playAttentionSound(): void {
  // Contexts are intentionally short-lived so no audio resource survives an alert.
  // Gateway event dedupe makes overlapping contexts exceptional.
  const AudioContextCtor = window.AudioContext;
  if (!AudioContextCtor) return;
  const context = new AudioContextCtor();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
  gain.connect(context.destination);
  for (const [frequency, offset] of [
    [660, 0],
    [880, 0.12],
  ] as const) {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(context.currentTime + offset);
    oscillator.stop(context.currentTime + offset + 0.14);
  }
  void context.resume().then(
    () => window.setTimeout(() => void context.close(), 500),
    (error) => {
      console.warn('[notifications] attention sound was blocked:', error);
      void context.close();
    },
  );
}

export async function requestPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') {
    permissionGranted = true;
    return true;
  }
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  permissionGranted = result === 'granted';
  return permissionGranted;
}

export function notify(
  title: string,
  options?: {
    body?: string;
    tag?: string;
    route?: string;
    attention?: boolean;
  },
): void {
  const preferences = getAttentionAlertPreferences();
  if (options?.attention && !preferences.attentionEnabled) return;
  // Attention alerts must share the same tag dedupe as browser notifications.
  // Otherwise a repeated gateway event replaces the OS notification but still
  // rings and redraws the in-app banner every time.
  if (options?.attention && options.tag) {
    const last = recentTags.get(options.tag);
    if (last && Date.now() - last < SUPPRESS_MS) return;
    recentTags.set(options.tag, Date.now());
  }
  if (options?.attention) {
    window.dispatchEvent(
      new CustomEvent<AttentionAlertDetail>(ATTENTION_ALERT_EVENT, {
        detail: { title, body: options.body, route: options.route },
      }),
    );
    if (preferences.sound) playAttentionSound();
  }
  if (!preferences.backgroundNotifications || !permissionGranted) return;
  if (document.hasFocus()) return;

  // Deduplicate by tag within suppress window
  if (!options?.attention && options?.tag) {
    const last = recentTags.get(options.tag);
    if (last && Date.now() - last < SUPPRESS_MS) return;
    recentTags.set(options.tag, Date.now());
  }

  const n = new Notification(title, {
    body: options?.body,
    tag: options?.tag,
    icon: '/favicon.ico',
  });

  if (options?.route) {
    n.onclick = () => {
      window.focus();
      window.location.hash = options.route!;
      n.close();
    };
  }
}
