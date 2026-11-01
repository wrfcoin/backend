/**
 * Payout notifications (backend#389): channel validation (no SSRF, no personal data), delivery outcomes,
 * the message text, the route's login/flag rules, the capability flip, and (with CHAIN_REWARD_TEST_PORT,
 * CI service container) the real-SQL subscription store and the earned-total watcher.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import {
  channelConfig, createDeliverer, isAllowedPushEndpoint, parseChannel, targetHash, type StoredSubscription,
} from '../server/services/payout-notify/channels.js';
import { payoutMessage, runPayoutNotifyOnce, wrf, type AccountRead } from '../server/services/payout-notify/watcher.js';
import { createPayoutNotificationRouter } from '../server/routes/payout-notification-routes.js';
import { createCapabilitiesRouter } from '../server/routes/capabilities-routes.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P256DH = 'B' + 'A'.repeat(86);
const AUTH = 'abcdefghijklmnopqrstuv';
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';
const webpushBody = (address: string, endpoint = FCM) => ({ address, channel: 'webpush', subscription: { endpoint, keys: { p256dh: P256DH, auth: AUTH } } });
const VAPID_PUBLIC = 'B' + 'x'.repeat(86);
const VAPID_PRIVATE = 'y'.repeat(43);

const FLAGS = ['PAYOUT_NOTIFY_ENABLED', 'WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_VAPID_SUBJECT', 'PAYOUT_NOTIFY_NTFY_SERVER', 'JWT_SECRET', 'PAYOUT_NOTIFY_SITE_URL'];
const saved: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]));
beforeEach(() => {
  process.env.PAYOUT_NOTIFY_ENABLED = 'true';
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = VAPID_PUBLIC;
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = VAPID_PRIVATE;
  delete process.env.WEB_PUSH_VAPID_SUBJECT; delete process.env.PAYOUT_NOTIFY_NTFY_SERVER; delete process.env.PAYOUT_NOTIFY_SITE_URL;
  process.env.JWT_SECRET = 'synthetic-jwt-secret-for-notification-tests-0123456789';
});
afterAll(() => { for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const bearer = (address: string) => `Bearer ${jwt.sign({ sub: address, type: 'access' }, process.env.JWT_SECRET!, { algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m' })}`;

describe('channels: only browser push services and an ntfy topic, never a user URL', () => {
  test.each([
    FCM, 'https://updates.push.services.mozilla.com/wpush/v2/gAAA', 'https://web.push.apple.com/QGuQ', 'https://wns2-by3p.notify.windows.com/w/?token=x',
  ])('allowed push endpoint %s', url => expect(isAllowedPushEndpoint(url)).toBe(true));
  test.each([
    'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x',
    'https://evilfcm.googleapis.com.evil.net/x', 'https://notfcm.googleapis.com.attacker.io/', 'https://169.254.169.254/latest', 'https://localhost/x',
    'https://example.com/fcm.googleapis.com', 'not a url', 42,
  ])('refused push endpoint %s', url => expect(isAllowedPushEndpoint(url)).toBe(false));
  test('parseChannel accepts a well-formed push subscription and an ntfy topic; refuses everything else', () => {
    expect(parseChannel(webpushBody(addr(1)))).toEqual({ channel: 'webpush', target: { endpoint: FCM, p256dh: P256DH, auth: AUTH } });
    expect(parseChannel({ channel: 'ntfy', topic: 'wrf-payouts-7f3a9c' })).toEqual({ channel: 'ntfy', topic: 'wrf-payouts-7f3a9c' });
    expect(parseChannel({ channel: 'ntfy', topic: 'short' })).toHaveProperty('error');
    expect(parseChannel({ channel: 'ntfy', topic: '../../admin/x' })).toHaveProperty('error');
    expect(parseChannel({ channel: 'email', email: 'a@b.c' })).toHaveProperty('error');
    expect(parseChannel({ channel: 'webhook', url: 'https://x' })).toHaveProperty('error');
    expect(parseChannel({ channel: 'webpush', subscription: { endpoint: FCM, keys: { p256dh: 'x', auth: AUTH } } })).toHaveProperty('error');
  });
  test('config: web push only with both VAPID keys; ntfy defaults to ntfy.sh, can be turned off or pointed at an https server', () => {
    expect(channelConfig({}).webPush).toBeNull();
    expect(channelConfig({ WEB_PUSH_VAPID_PUBLIC_KEY: VAPID_PUBLIC, WEB_PUSH_VAPID_PRIVATE_KEY: VAPID_PRIVATE }).webPush).toEqual({ publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: 'https://wrfcoin.com' });
    expect(channelConfig({}).ntfyServer).toBe('https://ntfy.sh');
    expect(channelConfig({ PAYOUT_NOTIFY_NTFY_SERVER: 'off' }).ntfyServer).toBeNull();
    expect(channelConfig({ PAYOUT_NOTIFY_NTFY_SERVER: 'https://ntfy.example.org/' }).ntfyServer).toBe('https://ntfy.example.org');
    expect(channelConfig({ PAYOUT_NOTIFY_NTFY_SERVER: 'http://10.0.0.5' }).ntfyServer).toBeNull();
  });
});

describe('delivery', () => {
  const msg = { title: 'WRFCoin payout', body: 'b', url: 'https://wrfcoin.com/explore?address=x', tag: 'payout-x' };
  const push: StoredSubscription = { id: '1', address: addr(1), channel: 'webpush', target: FCM, p256dh: P256DH, auth: AUTH };
  const ntfy: StoredSubscription = { id: '2', address: addr(1), channel: 'ntfy', target: 'wrf-payouts-7f3a9c', p256dh: null, auth: null };
  test('web push is sent with VAPID to the stored endpoint; 404/410 means gone, anything else failed', async () => {
    const sendWebPush = jest.fn(async () => ({ statusCode: 201 }));
    const d = createDeliverer({ sendWebPush });
    expect(await d.deliver(push, msg)).toBe('delivered');
    expect(sendWebPush).toHaveBeenCalledWith({ endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } }, JSON.stringify(msg), expect.objectContaining({ vapidDetails: { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: 'https://wrfcoin.com' } }));
    expect(await createDeliverer({ sendWebPush: async () => { throw Object.assign(new Error('x'), { statusCode: 410 }); } }).deliver(push, msg)).toBe('gone');
    expect(await createDeliverer({ sendWebPush: async () => { throw Object.assign(new Error('x'), { statusCode: 500 }); } }).deliver(push, msg)).toBe('failed');
  });
  test('a stored endpoint that is no longer allowed is never contacted', async () => {
    const sendWebPush = jest.fn(async () => ({ statusCode: 201 }));
    expect(await createDeliverer({ sendWebPush }).deliver({ ...push, target: 'https://169.254.169.254/x' }, msg)).toBe('failed');
    expect(sendWebPush).not.toHaveBeenCalled();
  });
  test('ntfy posts the message to <server>/<topic> with a title and click link, no redirects', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200 }));
    expect(await createDeliverer({ fetchImpl }).deliver(ntfy, msg)).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledWith('https://ntfy.sh/wrf-payouts-7f3a9c', expect.objectContaining({ method: 'POST', redirect: 'error', body: 'b', headers: expect.objectContaining({ Title: 'WRFCoin payout', Click: msg.url }) }));
    expect(await createDeliverer({ fetchImpl: async () => ({ status: 429 }) }).deliver(ntfy, msg)).toBe('failed');
    process.env.PAYOUT_NOTIFY_NTFY_SERVER = 'off';
    expect(await createDeliverer({ fetchImpl }).deliver(ntfy, msg)).toBe('failed');
  });
});

describe('message', () => {
  test('wrf formats base units exactly', () => {
    expect(wrf('125000000')).toBe('1.25');
    expect(wrf('100000000000')).toBe('1,000');
    expect(wrf('1')).toBe('0.00000001');
  });
  test('names indexed producer/attester pay and calls the rest node, station or forecast pay', () => {
    const m = payoutMessage(addr(0xab), '100000000', '350000000', 10234, [{ role: 'producer', amount: '50000000', height: '10200' }]);
    expect(m.title).toBe('WRFCoin payout');
    expect(m.body).toContain('was paid 2.5 WRF');
    expect(m.body).toContain('producer reward 0.5 WRF (block 10,200)');
    expect(m.body).toContain('plus 2 WRF of node, station or forecast pay');
    expect(m.body).toContain('Earned in total: 3.5 WRF');
    expect(m.url).toBe(`https://wrfcoin.com/explore?address=${addr(0xab)}`);
    expect(payoutMessage(addr(0xab), '0', '100000000', 5, []).body).not.toContain('node, station');
  });
});

describe('routes without a database', () => {
  const app = () => { const a = express(); a.use(express.json()); a.use('/api/notifications', createPayoutNotificationRouter({ rateLimit: null, pool: { connect: async () => { throw new Error('no db in this block'); } } })); return a; };
  test('config is public and says what is stored; flag off answers enabled:false with no keys', async () => {
    const on = await request(app()).get('/api/notifications/config');
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, webPush: { available: true, publicKey: VAPID_PUBLIC }, ntfy: { available: true, server: 'https://ntfy.sh' } });
    expect(on.body.stores).toMatch(/No email/);
    expect(JSON.stringify(on.body)).not.toContain(VAPID_PRIVATE);
    process.env.PAYOUT_NOTIFY_ENABLED = 'false';
    const off = await request(app()).get('/api/notifications/config');
    expect(off.body).toMatchObject({ enabled: false, webPush: { available: false, publicKey: null }, ntfy: { available: false, server: null } });
  });
  test('every subscription route needs the wallet login (401 before anything else, even with the flag off)', async () => {
    process.env.PAYOUT_NOTIFY_ENABLED = 'false';
    expect((await request(app()).post('/api/notifications/subscriptions').send(webpushBody(addr(1)))).status).toBe(401);
    expect((await request(app()).get(`/api/notifications/subscriptions/${addr(1)}`)).status).toBe(401);
    expect((await request(app()).delete('/api/notifications/subscriptions/00000000-0000-4000-8000-000000000000')).status).toBe(401);
    expect((await request(app()).post('/api/notifications/subscriptions/00000000-0000-4000-8000-000000000000/test')).status).toBe(401);
    expect((await request(app()).get(`/api/notifications/subscriptions/${addr(1)}`).set('Authorization', 'Bearer forged')).status).toBe(401);
  });
  test('flag off: a signed-in request is 503 NOTIFICATIONS_DISABLED', async () => {
    process.env.PAYOUT_NOTIFY_ENABLED = 'false';
    const r = await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(addr(1))).send(webpushBody(addr(1)));
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('NOTIFICATIONS_DISABLED');
  });
  test('another wallet cannot subscribe or list an address; bad bodies are 400; nothing reaches the database', async () => {
    expect((await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(addr(2))).send(webpushBody(addr(1)))).status).toBe(403);
    expect((await request(app()).get(`/api/notifications/subscriptions/${addr(1)}`).set('Authorization', bearer(addr(2)))).status).toBe(403);
    expect((await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(addr(1))).send({ address: addr(1), channel: 'webhook', url: 'http://10.0.0.1/' })).status).toBe(400);
    expect((await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(addr(1))).send(webpushBody(addr(1), 'https://attacker.example/x'))).status).toBe(400);
    expect((await request(app()).post('/api/notifications/unsubscribe').send({ channel: 'webpush', endpoint: 'https://attacker.example/x' })).status).toBe(400);
  });
  test('push without VAPID keys is refused as unavailable', async () => {
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    const r = await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(addr(1))).send(webpushBody(addr(1)));
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('CHANNEL_UNAVAILABLE');
  });
  test('a database failure is 503, never a partial answer', async () => {
    const r = await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(addr(1))).send({ address: addr(1), channel: 'ntfy', topic: 'wrf-payouts-7f3a9c' });
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('NOTIFICATIONS_UNAVAILABLE');
  });
});

describe('capabilities', () => {
  test('notifications is unavailable while off, configured (never operational without evidence) when on', async () => {
    const a = express(); a.use('/api', createCapabilitiesRouter());
    process.env.PAYOUT_NOTIFY_ENABLED = 'false';
    expect((await request(a).get('/api/capabilities')).body.features.notifications).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.PAYOUT_NOTIFY_ENABLED = 'true';
    const body = (await request(a).get('/api/capabilities')).body;
    expect(body.features.notifications.status).toBe('configured');
    expect(body.features.webhooks.status).toBe('unavailable');
    expect(body.publicReleaseReadiness.requiredCapabilities).not.toContain('notifications');
  });
});

const port = process.env.CHAIN_REWARD_TEST_PORT;
(port ? describe : describe.skip)('real PostgreSQL: payout notification store and watcher', () => {
  const schema = 'payout_notify_389_test';
  const pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres', options: `-c search_path=${schema},public` });
  const sent: Array<{ sub: StoredSubscription; body: string }> = [];
  let outcome: 'delivered' | 'gone' | 'failed' = 'delivered';
  const deliverer = { deliver: async (sub: StoredSubscription, m: { body: string }) => { sent.push({ sub, body: m.body }); return outcome; } };
  const app = () => { const a = express(); a.use(express.json()); a.use('/api/notifications', createPayoutNotificationRouter({ rateLimit: null, pool, deliverer })); return a; };
  const accounts: Record<string, AccountRead | null> = {};
  const run = () => runPayoutNotifyOnce({ pool, deliverer, readAccount: async a => accounts[a] ?? null, sleep: async () => {} });

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(readFileSync('drizzle/migrations/0037_payout_notifications.sql', 'utf8'));
  }, 60000);
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  test('subscribe (push and ntfy), list without the endpoint, idempotent re-subscribe, per-address cap, delete', async () => {
    const a = addr(0xa1);
    const push = await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(a)).send(webpushBody(a));
    expect(push.status).toBe(201);
    expect(push.body.subscription).toMatchObject({ address: a, channel: 'webpush', label: 'fcm.googleapis.com', targetHash: targetHash(FCM) });
    expect(JSON.stringify(push.body)).not.toContain(FCM);
    const again = await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(a.toUpperCase().replace('0X', '0x'))).send(webpushBody(a.toUpperCase().replace('0X', '0x')));
    expect(again.status).toBe(200);
    expect(again.body.subscription.id).toBe(push.body.subscription.id);
    const topic = await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(a)).send({ address: a, channel: 'ntfy', topic: 'wrf-payouts-7f3a9c' });
    expect(topic.status).toBe(201);
    const list = await request(app()).get(`/api/notifications/subscriptions/${a}`).set('Authorization', bearer(a));
    expect(list.body.subscriptions.map((s: any) => [s.channel, s.label])).toEqual([['webpush', 'fcm.googleapis.com'], ['ntfy', 'wrf-payouts-7f3a9c']]);
    expect(JSON.stringify(list.body)).not.toContain('/fcm/send/');
    // Columns stored: nothing beyond address, channel, target, keys, timestamps and a failure count.
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='payout_notification_subscriptions' ORDER BY ordinal_position")).rows.map(r => r.column_name);
    expect(cols).toEqual(['id', 'address', 'channel', 'target', 'target_hash', 'p256dh', 'auth', 'created_at', 'last_delivered_at', 'consecutive_failures']);

    for (let i = 0; i < 8; i++) {
      expect((await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(a)).send({ address: a, channel: 'ntfy', topic: `wrf-payouts-cap-${i}` })).status).toBe(201);
    }
    const capped = await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(a)).send({ address: a, channel: 'ntfy', topic: 'wrf-payouts-one-too-many' });
    expect(capped.status).toBe(409);
    await pool.query("DELETE FROM payout_notification_subscriptions WHERE target LIKE 'wrf-payouts-cap-%'");

    // Someone else's id answers like a missing one; the owner deletes it.
    const id = topic.body.subscription.id;
    expect((await request(app()).delete(`/api/notifications/subscriptions/${id}`).set('Authorization', bearer(addr(0xb2)))).status).toBe(404);
    expect((await request(app()).delete(`/api/notifications/subscriptions/${id}`).set('Authorization', bearer(a)))).toMatchObject({ status: 200 });
  });

  test('test notification goes to that subscription only, once a minute', async () => {
    const a = addr(0xa1);
    const id = (await pool.query("SELECT id::text AS id FROM payout_notification_subscriptions WHERE channel='webpush'")).rows[0].id;
    sent.length = 0;
    const one = app();
    const r = await request(one).post(`/api/notifications/subscriptions/${id}/test`).set('Authorization', bearer(a));
    expect(r.body).toEqual({ success: true, delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('Notifications are on');
    expect((await request(one).post(`/api/notifications/subscriptions/${id}/test`).set('Authorization', bearer(a))).status).toBe(429);
  });

  test('watcher: first read is a baseline, an increase notifies once with attribution, unchanged and drops do not', async () => {
    const a = addr(0xa1);
    sent.length = 0;
    accounts[a] = { earned: '100000000', height: 100 };
    expect(await run()).toMatchObject({ addresses: 1, baselines: 1, payouts: 0 });
    expect(sent).toHaveLength(0);

    accounts[a] = { earned: '350000000', height: 120 };
    const attributed = await runPayoutNotifyOnce({ pool, deliverer, readAccount: async x => accounts[x] ?? null, sleep: async () => {},
      attribute: async (_x, after, through) => (after === 100 && through === 120 ? [{ role: 'producer', amount: '50000000', height: '110' }] : []) });
    expect(attributed).toMatchObject({ payouts: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('was paid 2.5 WRF');
    expect(sent[0].body).toContain('producer reward 0.5 WRF');

    // Same total again (e.g. a restart): no second notification.
    expect(await run()).toMatchObject({ payouts: 0 });
    // A replayed event row for the same total is refused by the primary key.
    await pool.query("UPDATE payout_notification_watch SET earned_total=100000000 WHERE address=$1", [a]);
    expect(await run()).toMatchObject({ payouts: 0 });
    expect(sent).toHaveLength(1);
    // A drop (chain reset) re-baselines silently.
    accounts[a] = { earned: '0', height: 5 };
    expect(await run()).toMatchObject({ payouts: 0 });
    expect((await pool.query('SELECT earned_total::text AS e FROM payout_notification_watch WHERE address=$1', [a])).rows[0].e).toBe('0');
    // An unreadable account (node down, older node without earned_balance_total) is skipped.
    accounts[a] = null;
    expect(await run()).toMatchObject({ readFailures: 1, payouts: 0 });
    accounts[a] = { earned: null, height: 6 };
    expect(await run()).toMatchObject({ readFailures: 1, payouts: 0 });
  });

  test('a gone push subscription is deleted; failures count up; unsubscribe by endpoint needs no login', async () => {
    const a = addr(0xa1);
    accounts[a] = { earned: '1', height: 7 };
    await run(); // baseline 0 -> 1 notifies
    outcome = 'failed';
    accounts[a] = { earned: '2', height: 8 };
    await run();
    expect((await pool.query("SELECT consecutive_failures FROM payout_notification_subscriptions WHERE channel='webpush'")).rows[0].consecutive_failures).toBe(1);
    outcome = 'gone';
    accounts[a] = { earned: '3', height: 9 };
    await run();
    expect((await pool.query('SELECT count(*)::int AS n FROM payout_notification_subscriptions')).rows[0].n).toBe(0);
    outcome = 'delivered';
    // Re-subscribe, then turn it off from the browser that holds the endpoint.
    expect((await request(app()).post('/api/notifications/subscriptions').set('Authorization', bearer(a)).send(webpushBody(a))).status).toBe(201);
    const off = await request(app()).post('/api/notifications/unsubscribe').send({ channel: 'webpush', endpoint: FCM });
    expect(off.body).toEqual({ success: true, removed: 1 });
    // With no subscriptions left, the watch row is pruned.
    await run();
    expect((await pool.query('SELECT count(*)::int AS n FROM payout_notification_watch')).rows[0].n).toBe(0);
  });

  test('migration 0037 is reversible: the documented down drops only its tables and the up re-applies', async () => {
    const up = readFileSync('drizzle/migrations/0037_payout_notifications.sql', 'utf8');
    const down = /^-- Down \(reversible\): (.+)$/m.exec(up)?.[1];
    expect(down).toBe('DROP TABLE payout_notification_events; DROP TABLE payout_notification_watch; DROP TABLE payout_notification_subscriptions;');
    const tables = async () => (await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name", [schema])).rows.map(r => r.table_name);
    const before = await tables();
    expect(before).toEqual(['payout_notification_events', 'payout_notification_subscriptions', 'payout_notification_watch']);
    await pool.query(down!);
    expect(await tables()).toEqual([]);
    await pool.query(up);
    expect(await tables()).toEqual(before);
  });
});
