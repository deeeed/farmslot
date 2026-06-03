// Browser Notification API wrapper for farmslot alerts

let permissionGranted = false;
const suppressUntil = 0;

const SUPPRESS_MS = 5_000; // suppress duplicate triggers within 5s
const recentTags = new Map<string, number>();

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
  },
): void {
  if (!permissionGranted) return;
  if (document.hasFocus()) return; // don't notify if tab is focused

  // Deduplicate by tag within suppress window
  if (options?.tag) {
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
