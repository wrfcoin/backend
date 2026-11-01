/**
 * Delivery channels for payout notifications (backend#389, owner ruling 2026-11-01: no personal data).
 *
 * Two channels, both free and both anonymous:
 *   - Web Push: the browser's own push subscription (an endpoint URL at the browser vendor's push service
 *     plus two public keys). Sent with VAPID; the payload is encrypted to the browser by web-push. The
 *     endpoint must be https on a known browser push service host, checked when it is registered AND again
 *     before every send, so a registered URL can never become a request to an arbitrary host (SSRF).
 *   - ntfy: a topic name the user picks, posted to ONE operator-configured ntfy server (default
 *     https://ntfy.sh). Users never supply a URL, only the topic.
 * Never email, never a phone number, never a user-supplied webhook URL.
 */
import crypto from 'node:crypto';

/** Browser push services (Chrome/Edge/Android via FCM, Firefox, Safari/iOS, Windows WNS). */
const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
export const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{12,64}$/;
export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export interface WebPushTarget { endpoint: string; p256dh: string; auth: string }
export type ChannelInput =
  | { channel: 'webpush'; target: WebPushTarget }
  | { channel: 'ntfy'; topic: string };

export const targetHash = (target: string) => crypto.createHash('sha256').update(target).digest('hex');

/** https, default port, no credentials, host on a browser push service. */
export function isAllowedPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 1024) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

/** Parse a subscription request body into a channel target, or a reason it was refused. */
export function parseChannel(body: any): ChannelInput | { error: string } {
  if (body?.channel === 'webpush') {
    const sub = body.subscription;
    const endpoint = sub?.endpoint, p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
    if (!isAllowedPushEndpoint(endpoint)) return { error: 'subscription.endpoint must be a browser push service URL' };
    if (typeof p256dh !== 'string' || p256dh.length < 80 || p256dh.length > 100 || !B64URL_RE.test(p256dh)) return { error: 'subscription.keys.p256dh is malformed' };
    if (typeof auth !== 'string' || auth.length < 16 || auth.length > 32 || !B64URL_RE.test(auth)) return { error: 'subscription.keys.auth is malformed' };
    return { channel: 'webpush', target: { endpoint, p256dh, auth } };
  }
  if (body?.channel === 'ntfy') {
    if (typeof body.topic !== 'string' || !NTFY_TOPIC_RE.test(body.topic)) return { error: 'topic must be 12-64 letters, digits, _ or -' };
    return { channel: 'ntfy', topic: body.topic };
  }
  return { error: 'channel must be webpush or ntfy' };
}

export interface ChannelConfig {
  webPush: { publicKey: string; privateKey: string; subject: string } | null;
  ntfyServer: string | null;
}

/** Read per call so an operator can change env without a code path caching stale values. */
export function channelConfig(env: Record<string, string | undefined> = process.env): ChannelConfig {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.WEB_PUSH_VAPID_SUBJECT?.trim() || 'https://wrfcoin.com';
  const webPush = B64URL_RE.test(publicKey) && publicKey.length >= 80 && B64URL_RE.test(privateKey) && privateKey.length >= 40 &&
    /^(https:\/\/|mailto:)/.test(subject) ? { publicKey, privateKey, subject } : null;
  const rawNtfy = env.PAYOUT_NOTIFY_NTFY_SERVER?.trim();
  let ntfyServer: string | null = 'https://ntfy.sh';
  if (rawNtfy === 'off') ntfyServer = null;
  else if (rawNtfy) {
    try {
      const u = new URL(rawNtfy);
      ntfyServer = u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash ? u.origin + u.pathname.replace(/\/+$/, '') : null;
    } catch { ntfyServer = null; }
  }
  return { webPush, ntfyServer };
}

export interface NotificationMessage { title: string; body: string; url: string; tag: string }
export type DeliveryOutcome = 'delivered' | 'gone' | 'failed';
export interface StoredSubscription { id: string; address: string; channel: 'webpush' | 'ntfy'; target: string; p256dh: string | null; auth: string | null }

type WebPushSend = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: Record<string, unknown>) => Promise<{ statusCode: number }>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number }>;

export interface Deliverer { deliver(sub: StoredSubscription, message: NotificationMessage): Promise<DeliveryOutcome> }

/** The real sender. `sendWebPush`/`fetchImpl` are injectable so tests never reach a network. */
export function createDeliverer(deps: { config?: () => ChannelConfig; sendWebPush?: WebPushSend; fetchImpl?: FetchLike } = {}): Deliverer {
  const config = deps.config ?? (() => channelConfig());
  let webPushModule: Promise<WebPushSend> | null = null;
  const getWebPush = (): Promise<WebPushSend> => {
    if (deps.sendWebPush) return Promise.resolve(deps.sendWebPush);
    webPushModule ??= import('web-push').then(m => ((m as any).default ?? m).sendNotification as WebPushSend);
    return webPushModule;
  };
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    async deliver(sub, message) {
      const cfg = config();
      if (sub.channel === 'webpush') {
        if (!cfg.webPush || !isAllowedPushEndpoint(sub.target) || !sub.p256dh || !sub.auth) return 'failed';
        try {
          const send = await getWebPush();
          await send({ endpoint: sub.target, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(message), {
            vapidDetails: cfg.webPush, TTL: 24 * 60 * 60, timeout: 10_000, urgency: 'normal', topic: message.tag.slice(0, 32),
          });
          return 'delivered';
        } catch (e) {
          const status = (e as { statusCode?: number })?.statusCode;
          // 404/410: the browser dropped the subscription; it will never work again.
          return status === 404 || status === 410 ? 'gone' : 'failed';
        }
      }
      if (!cfg.ntfyServer || !NTFY_TOPIC_RE.test(sub.target)) return 'failed';
      try {
        const response = await fetchImpl(`${cfg.ntfyServer}/${sub.target}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { Title: message.title, Click: message.url, Tags: 'moneybag', 'Content-Type': 'text/plain; charset=utf-8' },
          body: message.body,
        });
        return response.status >= 200 && response.status < 300 ? 'delivered' : 'failed';
      } catch { return 'failed'; }
    },
  };
}
