/**
 * backend#1361 (owner ruling): the public leaderboard must not hand anonymous callers a full wallet
 * address. Anonymous callers get the short form and the display name; the full address is for the
 * operator bearer and for the wallet's own login only. The link key is an opaque HMAC alias.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

import { createWeatherLeaderboardRouter } from '../../server/routes/weather-leaderboard-routes.js';
import { createOperatorProfileRouter } from '../../server/routes/operator-profile-routes.js';
import crypto from 'node:crypto';
import { profileKeyFor, shortAddress, isProfileKey, createProfileKeyResolver } from '../../server/utils/contributor-alias.js';

type Row = Record<string, unknown>;

const JWT_SECRET = 'leaderboard-1361-secret-0123456789abcdef';
const OPERATOR = 'operator-token-1361-0123456789abcdef';
const ALICE = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const BOB = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const NATIVE = 'wrf' + 'c3'.repeat(20);
const ANY_FULL_ADDRESS = /(?:0x|wrf)[0-9a-f]{40}/i;

const rows = (): Row[] => [
  { rank: 1, wallet_address: ALICE, display_name: 'Alice', value: 90, country: 'US', city: 'Chicago' },
  { rank: 2, wallet_address: BOB, display_name: 'Bob', value: 50, country: 'GB', city: 'London' },
  { rank: 3, wallet_address: NATIVE, display_name: 'Cy', value: 20, country: 'DE', city: 'Berlin' },
];

function makeApp(cache: any = null) {
  const execute = jest.fn(async () => ({ rows: rows() }));
  const app = express();
  app.use('/api/weather/leaderboard', createWeatherLeaderboardRouter({ db: { execute } as any, cache, rateLimit: null }));
  return { app, execute };
}

function walletToken(sub: string, overrides: Record<string, unknown> = {}) {
  return jwt.sign({ sub, type: 'access', ...overrides }, JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'wrfcoin-platform',
    audience: 'wrfcoin-api',
    expiresIn: '5m',
  });
}

let savedEnv: Record<string, string | undefined>;
beforeAll(() => {
  savedEnv = { JWT_SECRET: process.env.JWT_SECRET, OP: process.env.WRFCOIN_OPERATOR_TOKEN, ALIAS: process.env.WRFCOIN_PUBLIC_ALIAS_SECRET };
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  delete process.env.WRFCOIN_PUBLIC_ALIAS_SECRET;
});
afterAll(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('JWT_SECRET', savedEnv.JWT_SECRET);
  restore('WRFCOIN_OPERATOR_TOKEN', savedEnv.OP);
  restore('WRFCOIN_PUBLIC_ALIAS_SECRET', savedEnv.ALIAS);
});

describe('anonymous callers never receive a full wallet address (#1361)', () => {
  it.each(['submissions', 'quality_score', 'streak'])('metric %s: short address + display name only', async metric => {
    const { app } = makeApp();
    const res = await request(app).get(`/api/weather/leaderboard?metric=${metric}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(ANY_FULL_ADDRESS);
    expect(res.body.entries.map((e: any) => e.walletAddress)).toEqual([
      '0xa1a1…a1a1',
      '0xb2b2…b2b2',
      'wrfc3c…c3c3',
    ]);
    expect(res.body.entries.map((e: any) => e.displayName)).toEqual(['Alice', 'Bob', 'Cy']);
    expect(res.body.entries.every((e: any) => e.isYou === false)).toBe(true);
  });

  it('every row carries an opaque profile key that is neither the address nor derived from a prefix', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    const keys = res.body.entries.map((e: any) => e.profileKey);
    expect(keys.every((k: string) => isProfileKey(k))).toBe(true);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(profileKeyFor(ALICE));
    expect(keys[0]).toBe(profileKeyFor(ALICE.toUpperCase().replace('0X', '0x'))); // case-insensitive, stable
    expect(JSON.stringify(keys)).not.toMatch(/a1a1|b2b2/i);
  });

  it('a garbage bearer token is treated as anonymous (short addresses, cache still used)', async () => {
    const cache = { get: jest.fn(async () => null), setex: jest.fn(async () => 'OK') };
    const { app } = makeApp(cache);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions').set('Authorization', 'Bearer not-a-token');
    expect(res.text).not.toMatch(ANY_FULL_ADDRESS);
    expect(cache.get).toHaveBeenCalledTimes(1);
  });

  it('an expired or wrong-audience wallet token does not widen anything', async () => {
    const { app } = makeApp();
    const expired = jwt.sign({ sub: ALICE, type: 'access' }, JWT_SECRET, {
      algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: -10,
    });
    const wrongAud = jwt.sign({ sub: ALICE, type: 'access' }, JWT_SECRET, {
      algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'someone-else', expiresIn: '5m',
    });
    const refresh = walletToken(ALICE, { type: 'refresh' });
    for (const token of [expired, wrongAud, refresh]) {
      const res = await request(app).get('/api/weather/leaderboard?metric=submissions').set('Authorization', `Bearer ${token}`);
      expect(res.text).not.toMatch(ANY_FULL_ADDRESS);
    }
  });

  it('the cache holds only the anonymous projection, under a v3 key', async () => {
    const cache = { get: jest.fn(async () => null), setex: jest.fn(async () => 'OK') };
    const { app } = makeApp(cache);
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(cache.setex).toHaveBeenCalledTimes(1);
    const [key, , value] = cache.setex.mock.calls[0] as unknown as [string, number, string];
    expect(key).toContain('cache:leaderboard:v3:');
    expect(value).not.toMatch(ANY_FULL_ADDRESS);
  });
});

describe('who does see a full address', () => {
  it('the operator bearer sees every full address and bypasses the cache', async () => {
    const cache = { get: jest.fn(async () => '{"success":true,"entries":[]}'), setex: jest.fn(async () => 'OK') };
    const { app, execute } = makeApp(cache);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions').set('Authorization', `Bearer ${OPERATOR}`);
    expect(res.body.entries.map((e: any) => e.walletAddress)).toEqual([ALICE, BOB, NATIVE]);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.setex).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a wallet login sees its OWN row in full (isYou) and everyone else short', async () => {
    const cache = { get: jest.fn(async () => null), setex: jest.fn(async () => 'OK') };
    const { app } = makeApp(cache);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions').set('Authorization', `Bearer ${walletToken(BOB.toUpperCase().replace('0X', '0x'))}`);
    const [a, b, c] = res.body.entries;
    expect(a.walletAddress).toBe('0xa1a1…a1a1');
    expect(b.walletAddress).toBe(BOB);
    expect(b.isYou).toBe(true);
    expect(c.walletAddress).toBe('wrfc3c…c3c3');
    expect(res.text.match(ANY_FULL_ADDRESS)?.length).toBe(1);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.setex).not.toHaveBeenCalled();
  });

  it('a verified viewer never poisons the anonymous cache: the next anonymous read is short', async () => {
    const store = new Map<string, string>();
    const cache = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      setex: jest.fn(async (k: string, _s: number, v: string) => { store.set(k, v); return 'OK'; }),
    };
    const { app } = makeApp(cache);
    await request(app).get('/api/weather/leaderboard?metric=submissions').set('Authorization', `Bearer ${OPERATOR}`);
    const anon = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(anon.text).not.toMatch(ANY_FULL_ADDRESS);
  });
});

describe('profile keys', () => {
  it('is derived from a dedicated sub-key, not from the raw secret', () => {
    const sub = crypto.createHmac('sha256', JWT_SECRET).update('wrf-profile-alias-key-v1').digest();
    const expected = 'c_' + crypto.createHmac('sha256', sub).update(ALICE).digest('hex').slice(0, 24);
    expect(profileKeyFor(ALICE)).toBe(expected);
    const direct = 'c_' + crypto.createHmac('sha256', JWT_SECRET).update(ALICE).digest('hex').slice(0, 24);
    expect(profileKeyFor(ALICE)).not.toBe(direct);
  });

  it('the dedicated alias secret overrides JWT_SECRET, and a rotation changes every key', () => {
    const before = profileKeyFor(ALICE);
    process.env.WRFCOIN_PUBLIC_ALIAS_SECRET = 'a-different-alias-secret-0123456789abcdef';
    try {
      expect(profileKeyFor(ALICE)).not.toBe(before);
    } finally {
      delete process.env.WRFCOIN_PUBLIC_ALIAS_SECRET;
    }
    expect(profileKeyFor(ALICE)).toBe(before);
  });

  it('shortAddress is idempotent-safe and keeps 6 + 4 characters', () => {
    expect(shortAddress(ALICE)).toBe('0xa1a1…a1a1');
    expect(shortAddress('0x12345')).toBe('0x12345');
  });

  it('no server secret means no key, never a guessable one', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(profileKeyFor(ALICE)).toBeNull();
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});

describe('operator profile by key (the leaderboard link target)', () => {
  const user = (address: string) => ({ id: 7, wallet_address: address, created_at: '2026-01-15T00:00:00.000Z' });
  function profileDb() {
    const execute = jest.fn(async (sql: string) => {
      if (/FROM users WHERE wallet_address IS NOT NULL/.test(sql)) {
        return { rows: [{ wallet_address: ALICE }, { wallet_address: BOB }] };
      }
      if (/FROM users WHERE wallet_address = \$1/.test(sql)) return { rows: [user(ALICE)] };
      if (/COUNT\(\*\) as total_submissions/.test(sql)) return { rows: [{ total_submissions: 12, last_submission: null, avg_quality: 90 }] };
      if (/station_count/.test(sql)) return { rows: [{ station_count: 1 }] };
      if (/longest_streak/.test(sql)) return { rows: [{ longest_streak: 4 }] };
      if (/current_streak/.test(sql)) return { rows: [{ current_streak: 2 }] };
      if (/total_rewards/.test(sql)) return { rows: [{ total_rewards: '500' }] };
      if (/rank/.test(sql)) return { rows: [{ rank: 1 }] };
      return { rows: [] };
    });
    const app = express();
    app.use('/api/operators', createOperatorProfileRouter({ execute } as any));
    return { app, execute };
  }

  it('an anonymous caller resolves the key and gets the short address, never the full one', async () => {
    const { app } = profileDb();
    const key = profileKeyFor(ALICE)!;
    const res = await request(app).get(`/api/operators/${key}/profile`);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(ANY_FULL_ADDRESS);
    expect(res.body.profile.walletAddress).toBe('0xa1a1…a1a1');
    expect(res.body.profile.profileKey).toBe(key);
    expect(res.body.profile.totalRewardsEarned).toBeNull();
    expect(res.body.profile.totalSubmissions).toBe(12);
  });

  it('the operator bearer and the wallet itself see the full address', async () => {
    const { app } = profileDb();
    const key = profileKeyFor(ALICE)!;
    const op = await request(app).get(`/api/operators/${key}/profile`).set('Authorization', `Bearer ${OPERATOR}`);
    expect(op.body.profile.walletAddress).toBe(ALICE);
    const own = await request(app).get(`/api/operators/${key}/profile`).set('Authorization', `Bearer ${walletToken(ALICE)}`);
    expect(own.body.profile.walletAddress).toBe(ALICE);
    expect(own.body.profile.isYou).toBe(true);
    const other = await request(app).get(`/api/operators/${key}/profile`).set('Authorization', `Bearer ${walletToken(BOB)}`);
    expect(other.body.profile.walletAddress).toBe('0xa1a1…a1a1');
  });

  it('the whole anonymous alias-lookup body carries no identifying field beyond the short address', async () => {
    const { app } = profileDb();
    const key = profileKeyFor(ALICE)!;
    const profile = await request(app).get(`/api/operators/${key}/profile`);
    const meta = await request(app).get(`/api/operators/${key}/og-meta`);
    // Exact allowlist: a new field must be reviewed before it can appear here.
    expect(Object.keys(profile.body.profile).sort()).toEqual([
      'badges', 'coverageRegion', 'currentStreak', 'displayName', 'isYou', 'joinedAt', 'lastSubmission',
      'longestStreak', 'profileKey', 'qualityScore', 'rank', 'stationCount', 'totalRewardsEarned',
      'totalSubmissions', 'walletAddress',
    ]);
    expect(Object.keys(meta.body.meta).sort()).toEqual(['description', 'imageUrl', 'shortAddr', 'title', 'walletAddress']);
    // Denylist on top of the allowlist, over every key at any depth and over the raw text.
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(profile.body); walk(meta.body);
    expect(keys.filter(k => /email|phone|location|latitude|longitude|lat$|lng$|geohash|station_?id|device|mac|user_?id|^id$|password|token|secret|owner|pubkey|public_?key|address$/i.test(k)))
      .toEqual(['walletAddress', 'walletAddress']);
    for (const res of [profile, meta]) {
      expect(res.text).not.toMatch(ANY_FULL_ADDRESS);
      expect(res.text).not.toMatch(/@|\bmob-[0-9a-f]{32}\b/);
    }
    expect(profile.body.profile.totalRewardsEarned).toBeNull();
  });

  it('an unknown key is a 404 that echoes nothing, and probing is throttled to few user scans', async () => {
    const { app, execute } = profileDb();
    for (let i = 0; i < 6; i++) {
      const res = await request(app).get(`/api/operators/c_${String(i).padStart(24, '0')}/profile`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Operator not found' });
    }
    const scans = execute.mock.calls.filter(c => /FROM users WHERE wallet_address IS NOT NULL/.test(String(c[0]))).length;
    expect(scans).toBeLessThanOrEqual(2);
  });

  it('a key that resolves but whose user row has vanished is still a 404 that echoes nothing', async () => {
    // A fresh address: fetchProfile keeps a module-level cache keyed by address.
    const GONE = '0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
    const execute = jest.fn(async (sql: string) =>
      /FROM users WHERE wallet_address IS NOT NULL/.test(sql) ? { rows: [{ wallet_address: GONE }] } : { rows: [] });
    const app = express();
    app.use('/api/operators', createOperatorProfileRouter({ execute } as any));
    for (const path of ['profile', 'og-meta']) {
      const res = await request(app).get(`/api/operators/${profileKeyFor(GONE)}/${path}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Operator not found' });
    }
  });

  it('og-meta by key never puts the full address in the URL or body for an anonymous caller', async () => {
    const { app } = profileDb();
    const key = profileKeyFor(ALICE)!;
    const res = await request(app).get(`/api/operators/${key}/og-meta`);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(ANY_FULL_ADDRESS);
    expect(res.body.meta.imageUrl).toBe(`/api/operators/${key}/card.png`);
  });

  it('lookup by full address still works exactly as before (the caller already has the address)', async () => {
    const { app } = profileDb();
    const res = await request(app).get(`/api/operators/${ALICE}/profile`);
    expect(res.status).toBe(200);
    expect(res.body.profile.walletAddress).toBe(ALICE);
  });

  it('an anonymous raw-address lookup gets NO profile key (it would be an address -> leaderboard-row oracle)', async () => {
    const { app } = profileDb();
    const leaderboard = await request(makeApp().app).get('/api/weather/leaderboard?metric=submissions');
    const aliceRow = leaderboard.body.entries.find((e: any) => e.displayName === 'Alice');
    const res = await request(app).get(`/api/operators/${ALICE}/profile`);
    expect(res.status).toBe(200);
    expect(res.body.profile.profileKey).toBeNull();
    // The correlation itself: nothing in the raw-address answer equals the public row's key.
    expect(res.text).not.toContain(aliceRow.profileKey);
    const meta = await request(app).get(`/api/operators/${ALICE}/og-meta`);
    expect(meta.text).not.toContain(aliceRow.profileKey);
  });

  it('the operator and the owning wallet still get the key on a raw-address lookup; another wallet does not', async () => {
    const { app } = profileDb();
    const key = profileKeyFor(ALICE);
    const op = await request(app).get(`/api/operators/${ALICE}/profile`).set('Authorization', `Bearer ${OPERATOR}`);
    expect(op.body.profile.profileKey).toBe(key);
    const own = await request(app).get(`/api/operators/${ALICE}/profile`).set('Authorization', `Bearer ${walletToken(ALICE)}`);
    expect(own.body.profile.profileKey).toBe(key);
    expect(own.body.profile.isYou).toBe(true);
    const other = await request(app).get(`/api/operators/${ALICE}/profile`).set('Authorization', `Bearer ${walletToken(BOB)}`);
    expect(other.body.profile.profileKey).toBeNull();
  });

  it('a malformed key is a 400', async () => {
    const { app } = profileDb();
    const res = await request(app).get('/api/operators/not-an-address/profile');
    expect(res.status).toBe(400);
  });
});

describe('profile key resolver: the users scan stays bounded (#1386 review)', () => {
  const T0 = 1_800_000_000_000;
  let now = T0;
  let spy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => { now = T0; spy = jest.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => { spy.mockRestore(); });

  const deferred = () => {
    let resolve!: (v: { rows: Row[] }) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<{ rows: Row[] }>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const unknownKey = (i: number) => 'c_' + i.toString(16).padStart(24, '0');

  it('20 concurrent COLD misses share one users scan', async () => {
    const gate = deferred();
    const execute = jest.fn(() => gate.promise);
    const resolveKey = createProfileKeyResolver({ execute } as any);
    const calls = Array.from({ length: 20 }, (_, i) => resolveKey(unknownKey(i + 1)));
    gate.resolve({ rows: [{ wallet_address: ALICE }] });
    expect(await Promise.all(calls)).toEqual(Array(20).fill(null));
    expect(execute).toHaveBeenCalledTimes(1);
    // and a real key now resolves from the shared map without another scan
    expect(await resolveKey(profileKeyFor(ALICE)!)).toBe(ALICE);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('20 concurrent misses on an EXPIRED map share one rebuild', async () => {
    const execute = jest.fn(async () => ({ rows: [{ wallet_address: ALICE }] }));
    const resolveKey = createProfileKeyResolver({ execute } as any);
    await resolveKey(profileKeyFor(ALICE)!);
    expect(execute).toHaveBeenCalledTimes(1);
    now += 61_000;
    const gate = deferred();
    execute.mockImplementation(() => gate.promise);
    const calls = Array.from({ length: 20 }, (_, i) => resolveKey(unknownKey(i + 100)));
    gate.resolve({ rows: [{ wallet_address: ALICE }, { wallet_address: BOB }] });
    await Promise.all(calls);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await resolveKey(profileKeyFor(BOB)!)).toBe(BOB);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('a miss inside the 10 s window does not rescan; after it, it does (once)', async () => {
    const execute = jest.fn(async () => ({ rows: [{ wallet_address: ALICE }] }));
    const resolveKey = createProfileKeyResolver({ execute } as any);
    await resolveKey(profileKeyFor(ALICE)!);
    for (let i = 0; i < 5; i++) await resolveKey(unknownKey(i + 1));
    expect(execute).toHaveBeenCalledTimes(1);
    now += 10_500;
    await Promise.all(Array.from({ length: 5 }, (_, i) => resolveKey(unknownKey(i + 50))));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('a FAILED rebuild is shared by the waiting callers and then throttled, not retried per request', async () => {
    const gate = deferred();
    const execute = jest.fn(() => gate.promise);
    const resolveKey = createProfileKeyResolver({ execute } as any);
    const waiting = Array.from({ length: 10 }, (_, i) => resolveKey(unknownKey(i + 1)).then(() => 'ok', () => 'err'));
    gate.reject(new Error('db down'));
    expect(await Promise.all(waiting)).toEqual(Array(10).fill('err'));
    expect(execute).toHaveBeenCalledTimes(1);
    // inside the window: no new query, callers get an honest "not found" from the (empty) map
    for (let i = 0; i < 10; i++) expect(await resolveKey(unknownKey(i + 200))).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    // after the window the scan is retried once, and recovers
    now += 10_500;
    execute.mockImplementation(async () => ({ rows: [{ wallet_address: ALICE }] }));
    expect(await resolveKey(profileKeyFor(ALICE)!)).toBe(ALICE);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
