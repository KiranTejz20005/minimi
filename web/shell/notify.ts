import { api, type Preferences } from "../api";

/* Browser notifications + a short sound for the three events that matter when you've tabbed away:
   the agent needs your approval, an answer finished, or a run failed. Delivery per event comes from
   Settings > Notifications (GET /api/preferences). Nothing fires while this tab is in front. */

export type NotifyKind = "approval" | "finished" | "failed";
type NotifyPrefs = Pick<Preferences, "notifyApprovals" | "notifyFinished" | "notifyFailed" | "notifySound">;

let cache: NotifyPrefs | null = null;
let loading: Promise<void> | null = null;

export function setNotifyPrefs(p: NotifyPrefs): void {
  cache = { notifyApprovals: p.notifyApprovals, notifyFinished: p.notifyFinished, notifyFailed: p.notifyFailed, notifySound: p.notifySound };
}

async function ensure(): Promise<void> {
  if (cache) return;
  loading ??= api
    .preferences()
    .then(setNotifyPrefs)
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
  await loading;
}

export const notificationsSupported = () => typeof Notification !== "undefined";
export const notificationPermission = (): NotificationPermission | "unsupported" => (notificationsSupported() ? Notification.permission : "unsupported");

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** A soft two-note chime; silently does nothing where audio is blocked. */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.14);
      o.stop(now + i * 0.14 + 0.25);
    });
    window.setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    /* audio unavailable */
  }
}

export async function notify(kind: NotifyKind, title: string, body?: string): Promise<void> {
  if (typeof document === "undefined" || !document.hidden) return;
  await ensure();
  if (!cache) return;
  const mode = kind === "approval" ? cache.notifyApprovals : kind === "finished" ? cache.notifyFinished : cache.notifyFailed;
  if (mode === "off") return;
  if (cache.notifySound) playChime();
  if (notificationPermission() === "granted") {
    try {
      new Notification(title, { body: body?.slice(0, 140), tag: `minimi-${kind}` });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
}

/** Settings > Notifications "Send test": ignores the tab-in-front rule and the per-event delivery. */
export async function testNotification(sound: boolean): Promise<void> {
  if (sound) playChime();
  if (notificationPermission() === "default") await requestNotificationPermission();
  if (notificationPermission() === "granted") {
    try {
      new Notification("Minimi", { body: "This is what an alert looks like.", tag: "minimi-test" });
    } catch {
      /* unsupported context */
    }
  }
}
