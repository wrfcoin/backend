/**
 * Backend H11: seeded leak audit for every anonymous GET (see anonymous-get-ratchet-h11.test.ts).
 *
 * A throwaway database on the server named by MOBILE_STATION_PG_URL gets every drizzle
 * migration plus rows whose sensitive values are unmistakable markers (synthetic
 * coordinates 10.123456 / 20.654321, four owner/referral wallet addresses, reward
 * amounts, a MAC, a street address, a device key). The live entrypoint boots against it,
 * and every route the reviewed baseline calls anonymous is fetched with each relevant
 * marker as its :param. No response may contain a coordinate finer than 0.1 deg (owner ruling
 * 2026-10-01; echoes of the caller's own coordinates and pairs inside strings included), a
 * marker wallet other than the one the caller asked about, a reward marker, or the
 * other private fields. A positive control proves the scanner sees the markers when an
 * operator token is presented. MOBILE_STATION_REQUIRE_PG=1 (CI) makes a missing URL fail.
 */
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { bootLiveEntrypoint, concreteUrl, coverageProblems, expectationProblems, type Booted } from './helpers/anonymous-get-harness';
// The NOAA stub's upstream prose carries this pair, never the caller's (see the fixture).
const { UPSTREAM_TEXT_PAIR } = require('./fixtures/noaa-stub-preload.cjs');
const { stationAlias: aliasOfStation } = require('../server/utils/station-alias.js');

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;
if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('the seeded anonymous-GET leak audit would have been skipped');
  });
}

const OWNER = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const DEVICE_OWNER = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const REFERRER = '0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
const REFEREE = '0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
const WALLETS = [OWNER, DEVICE_OWNER, REFERRER, REFEREE];
const STATION = 'h11-station-1';
const DEVICE = 'h11-device-1';
const OPERATOR = 'test-operator-h11-0123456789abcdef';
const IOT_ADMIN = 'test-iot-admin-h11-0123456789abcdef'; // the harness's IOT_GATEWAY_ADMIN_TOKEN

// finer than 0.1 deg: two or more decimals of any marker coordinate (10.123456, 20.654321, and the
// NOAA stub's -20.987654). The lookbehinds skip ISO timestamps such as 09:20:10.123Z, whose seconds
// have the same shape, but not JSON like "latitude":10.12.
const FINE_COORD = [/(?<!\d:)(?<![\d.])-?10\.1\d/, /(?<!\d:)(?<![\d.])-?20\.6\d/, /(?<!\d:)(?<![\d.])-?20\.9\d/];

// The generic rule, independent of the markers: in a JSON body, no latitude/longitude-like field
// holds a number with more than one decimal, and no string holds a "d.dd+,d.dd+" pair.
const COORD_KEY = /^(lat|latitude|lng|lon|longitude)$|_(lat|latitude|lng|lon|longitude)$|[a-z0-9](Lat|Latitude|Lng|Lon|Longitude)$/;
const COORD_ARRAY_KEY = /^(coordinates|bbox|center)$/i;
// Any number form the weather parser accepts: sign or plus, decimals, exponent (backend#1397 r2).
const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_LIKE = new RegExp(String.raw`^\s*${NUM}\s*$`);
const PAIR = new RegExp(String.raw`(?<![\w.])(${NUM})\s*,\s*(${NUM})(?![\w.])`, 'g');
const finer = (n: number) => Number.isFinite(n) && Math.abs(n * 10 - Math.round(n * 10)) > 1e-6;
const finerThanOneDecimal = (v: unknown) =>
  finer(typeof v === 'number' ? v : typeof v === 'string' && NUMBER_LIKE.test(v) ? Number(v) : NaN);
// Stored names (backend#1397 r5): the seeded station, device and display names carry leading-dot
// coordinates. The station projections coarsen them; the global guard never rewrites text. Any
// anonymous body that carries one of the raw seeded values leaks a stored name, whatever its key.
const SEEDED_NAME_RAW = /\.10123456|\.20987654/;
// A "lat,lon"-shaped pair in text with either axis finer than one decimal, in any accepted form.
function hasFinePair(text: string): boolean {
  for (const m of text.matchAll(PAIR)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Math.abs(a) <= 180 && Math.abs(b) <= 180 && (finer(a) || finer(b))) return true;
  }
  return false;
}
function coordinateProblems(body: string): string[] {
  const problems: string[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { parsed = undefined; }
  if (parsed === undefined) {
    if (hasFinePair(body)) problems.push('coordinate pair in a non-JSON body');
    return problems;
  }
  // Scope (backend#1397, lead ruling): stored station/user coordinates and any echo of the
  // caller's input. Third-party NWS text (prose, station names, forecast period labels) is public
  // data and is not checked here; the coordinate-input test proves the caller's own values never
  // reach it. Stored names are checked by SEEDED_NAME_RAW in scan().
  const walk = (value: unknown, where: string, depth: number): void => {
    if (depth > 64) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${where}[${i}]`, depth + 1)); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const at = `${where}.${key}`;
      if (COORD_KEY.test(key) && finerThanOneDecimal(child)) problems.push(`${at}=${String(child)}`);
      if (COORD_ARRAY_KEY.test(key) && Array.isArray(child)) {
        const flat = (child as unknown[]).flat(Infinity as 1);
        for (const n of flat) if (finerThanOneDecimal(n)) problems.push(`${at} holds ${String(n)}`);
      }
      walk(child, at, depth + 1);
    }
  };
  walk(parsed, '$', 0);
  return problems;
}

// Anonymous routes whose input IS a coordinate (backend#1397 review): a coordinate path, the
// lat/lng query form and the leaderboard's near= echo. The NOAA stub (harness) lets each handler
// run end to end, so each must answer 200; a 4xx/5xx would make the check vacuous.
const C = '10.123456,-20.987654';
const Q = 'lat=10.123456&lng=-20.987654';
const RANGE = 'startDate=2026-09-01&endDate=2026-09-30';
const COORDINATE_PROBES = [
  `/api/weather/data/${C}`, `/api/weather/data/here?${Q}`,
  // backend#1397 r2: one fine axis, exponent and plus notation are accepted forms too.
  '/api/weather/data/10.123456,-21', '/api/weather/data/10.1,-20.987654',
  '/api/weather/data/1.0123456e1,-2.0987654e1', '/api/weather/data/+10.123456,-21',
  `/api/weather/current/${C}`, `/api/weather/current/here?${Q}`,
  `/api/weather/forecast/${C}`, `/api/weather/forecast/here?${Q}`,
  `/api/weather/historical/${C}?${RANGE}`, `/api/weather/historical/here?${Q}&${RANGE}`,
  `/api/weather/alerts/${C}`, `/api/weather/alerts/here?${Q}`,
  `/api/weather/stations?${Q}`,
  '/api/weather/leaderboard/?metric=submissions&near=10.123456,20.654321&radius_km=25',
  '/api/weather/leaderboard/?metric=submissions&near=10.123456,20.654321&radius_km=25&country=US&region=Europe',
];
const PRIVATE_FIELDS = [/4242\.1717/, /h11-private@example/i, /Private Place 99/, /H11 Display/, /7777\.4242/, /\b31337\b/, /aa:bb:cc:dd:ee:ff/i, /Test Street 1234/, /h11hw/, /h11pubkey/, /s3y0z1234/];

// Reviewed, accepted-for-now exposures, each tied to an issue. The audit fails if a NEW one appears
// or if one listed here stops appearing (so the entry is removed once the decision lands).
const KNOWN_EXPOSURES: Record<string, string[]> = {
  // backend#1361 (owner ruling): the public leaderboard shows the display name and a SHORT address only
  // (the full-address entry was removed when the fix landed; the name stays public by design).
  '/api/weather/leaderboard/': ['/H11 Display/'],
};

// The inline handler matches some routes by PREFIX (startsWith); probing the bare prefix is not a
// real request and gets no answer. These give the real sub-path (and the query it needs to return rows).
// Seeded DB-backed routes that must answer 200 AND show the seeded row's public projection.
const EXPORT_PROBE = `/api/v1/export/stations/${STATION}/observations?from=2020-01-01T00:00:00.000Z&to=2035-01-01T00:00:00.000Z&format=json`;
const SEEDED_EXPECTATIONS = [
  // The seeded row is present AND at one decimal (10.123456 -> 10.1; the comma pins the end).
  // Stored names are present AND coarsened by the station projections (backend#1397 r5).
  { url: '/api/iotex/devices', status: 200, contains: [DEVICE, '"latitude":10.1,', 'H11 Device 0.1,-0.2'] },
  { url: `/api/iotex/devices/${DEVICE}`, status: 200, contains: [DEVICE, '"latitude":10.1,', 'H11 Device 0.1,-0.2'] },
  { url: '/api/weather/stations', status: 200, contains: ['H11 Station 0.1,-0.2', '"latitude":10.1,'] },
  { url: '/api/weather/leaderboard/?metric=submissions', status: 200, contains: ['H11 Display 0.1,-0.2'] },
  { url: `/api/storage/weather/realtime/${STATION}`, status: 200, contains: [STATION] },
  { url: EXPORT_PROBE, status: 200, contains: [STATION] },
  { url: `/api/referrals/stats/${REFERRER}`, status: 200, contains: ['"totalReferrals":1'] },
];

const INLINE_PROBE_SUFFIX: Record<string, string> = {
  // backend#1456: the default metric is now the chain-backed earnings; this audit seeds submissions.
  '/api/weather/leaderboard/': '?metric=submissions',
  'inline:/api/v1/export/stations/*': '/observations?from=2020-01-01T00:00:00.000Z&to=2035-01-01T00:00:00.000Z&format=json',
};

d('anonymous GET responses hold no seeded private value (H11)', () => {
  const dbName = `h11_${process.pid}_${Date.now().toString(36)}`;
  let admin: Pool;
  let app: Booted;
  let templates: string[] = [];
  let dbUrl: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    const db = new Pool({ connectionString: dbUrl, max: 1 });
    const dir = path.join(__dirname, '../drizzle/migrations');
    for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
      await db.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    await db.query(
      `INSERT INTO weather_stations (station_id, owner_address, location, is_active, quality_score, total_rewards, latitude, longitude, name, station_type, metadata)
       VALUES ($1, $2, 'Test Street 1234, Nowhere', true, 80, '7777.4242', 10.123456, 20.654321, 'H11 Station .10123456,-.20987654', 'personal_weather_station', '{"mac":"aa:bb:cc:dd:ee:ff"}')`,
      [STATION, OWNER]);
    await db.query(
      `INSERT INTO weather_data (data_id, timestamp, latitude, longitude, station_id, temperature, pressure, data_hash, source_type)
       VALUES ('h11-data-1', now(), '10.123456', '20.654321', $1, '11.1', '1000.5', 'h11hash', 'station')`, [STATION]);
    await db.query(
      `INSERT INTO users (username, email, wallet_address, display_name, location, role)
       VALUES ('h11user', 'h11-private@example.invalid', $1, 'H11 Display .10123456,-.20987654', 'Private Place 99', 'user')`, [OWNER]);
    await db.query(
      `INSERT INTO weather_submissions (user_id, wallet_address, device_id, station_id, latitude, longitude, temperature, humidity, pressure,
                                        quality_score, reward_amount, source, submitted_at, country, city)
       SELECT id, $1, 'mobile:' || $1, $2, 10.123456, 20.654321, 11.1, 50, 1000.5, 90, 4242.1717, 'mobile', now(), 'ZZ', 'Privatecity'
         FROM users WHERE wallet_address = $1`, [OWNER, STATION]);
    await db.query(
      `INSERT INTO iotex_devices (id, name, type, latitude, longitude, geohash, owner, public_key, hardware_id)
       VALUES ($1, 'H11 Device .10123456,-.20987654', (enum_range(NULL::device_type))[1], 10.123456, 20.654321, 's3y0z1234', $2, 'h11pubkey', 'h11hw')`, [DEVICE, DEVICE_OWNER]);
    await db.query(
      `INSERT INTO referrals (referral_code, referrer_address, referee_address, status, reward_amount_wrf)
       VALUES ('H11CODE', $1, $2, 'rewarded', 31337)`, [REFERRER, REFEREE]);
    // B2 public paid-role amounts are approved; legacy reward markers remain private.
    const genesis = '11'.repeat(32);
    await db.query("INSERT INTO chain_reward_index_state(chain_id,genesis_hash,cursor_height,cursor_hash,status,checked_at) VALUES ('777',$1,1,$1,'ok',now())", [genesis]);
    await db.query("INSERT INTO chain_reward_blocks(chain_id,genesis_hash,height,block_hash,prev_hash,block_time,parser_version) VALUES ('777',$1,1,$1,$2,now(),1)", [genesis, '00'.repeat(32)]);
    await db.query("INSERT INTO chain_role_payouts VALUES ('777',$1,1,$1,'producer','producer:1',$2,$3,888000007)", [genesis, DEVICE_OWNER, 'ab'.repeat(32)]);
    // Same synthetic alias configuration as the live entrypoint; no secret is
    // passed to PostgreSQL, only public HMAC outputs.
    const aliasSecret = process.env.WRFCOIN_PUBLIC_ALIAS_SECRET || 'test-jwt-secret-for-h11-inventory-0123456789';
    const aliasKey = createHmac('sha256', aliasSecret).update('wrf-profile-alias-key-v1').digest();
    const alias = (input: string) => `c_${createHmac('sha256', aliasKey).update(input.toLowerCase()).digest('hex').slice(0,24)}`;
    await db.query('UPDATE chain_role_payees SET profile_key=$1,alias_epoch=$2 WHERE payee_address=$3',
      [alias(DEVICE_OWNER),alias('chain-role-payee-alias-epoch-v1'),DEVICE_OWNER]);
    await db.end();

    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/anonymous-get-baseline.json'), 'utf8')) as { anonymous: string[] };
    templates = baseline.anonymous;
    app = await bootLiveEntrypoint(dbUrl);
  }, 240_000);

  afterAll(async () => {
    try { await app?.stop(); } finally {
      await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin?.end();
    }
  });

  it('B2 enabled live earnings and non-user profiles expose approved amounts but no full identity or private markers', async () => {
    // Prevent background node work; the read API uses only this seeded disposable DB.
    const live = await bootLiveEntrypoint(dbUrl, { CHAIN_REWARD_INDEX_ENABLED:'true', CHAIN_REWARD_EARNINGS_ENABLED:'true', CHAIN_REWARD_INDEX_CHAIN_ID:'777', CHAIN_REWARD_INDEX_GENESIS_HASH:'11'.repeat(32), WRFCOIN_READER_TOKEN:'' });
    try {
      const board = await live.get('/api/earnings/leaderboard?role=producer&period=all&limit=30');
      expect(board.status).toBe(200);expect(scan(board.body,[])).toEqual([]);expect(board.body).not.toContain('ab'.repeat(32));
      const row=JSON.parse(board.body).rows[0];expect(row.paidBaseUnits).toBe('888000007');expect(row.displayName).toMatch(/^Operator-/);
      const profile=await live.get(`/api/operators/${row.profileKey}/profile`);expect(profile.status).toBe(200);expect(scan(profile.body,[])).toEqual([]);expect(profile.body).not.toContain('ab'.repeat(32));
      expect(JSON.parse(profile.body).profile.roleEarnings.roles.producer.paidBaseUnits).toBe('888000007');
      expect(JSON.parse(profile.body).profile.weatherStatisticsAvailable).toBe(false);
    } finally { await live.stop(); }
  }, 120000);

  const isAddressParam = (name: string) => /address|wallet|delegator|owner/i.test(name);
  function scan(body: string, asked: string[]): string[] {
    let text = body;
    for (const a of asked) text = text.split(new RegExp(a, 'i')).join('<asked>'); // echoing the requested id is not a leak
    const hits: string[] = [];
    for (const re of [...FINE_COORD, ...PRIVATE_FIELDS]) if (re.test(text)) hits.push(String(re));
    for (const problem of coordinateProblems(body)) hits.push(`coordinate ${problem}`);
    if (SEEDED_NAME_RAW.test(body)) hits.push('stored name with fine coordinates');
    for (const w of WALLETS) if (!asked.includes(w) && new RegExp(w.slice(2, 18), 'i').test(text)) hits.push(`wallet ${w.slice(0, 10)}`);
    return hits;
  }

  it('no anonymous route leaks a marker coordinate, wallet, reward or private field, and every probe was answered', async () => {
    const leaks: string[] = [];
    const seenKnown = new Set<string>();
    const expected: string[] = [];
    const answered: string[] = [];
    const results = new Map<string, { status: number; body: string }>();
    for (const template of templates) {
      const names = [...template.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      const variants = names.some(isAddressParam) ? WALLETS : [null];
      for (const wallet of variants) {
        const asked: string[] = [];
        const target = concreteUrl(template, (name) => {
          if (isAddressParam(name)) { asked.push(wallet as string); return wallet as string; }
          const id = /device/i.test(template) && name === 'id' ? DEVICE : STATION;
          asked.push(id);
          return id;
        });
        const probe = target + (INLINE_PROBE_SUFFIX[template] ?? '');
        expected.push(probe);
        let res: { status: number; body: string };
        try { res = await app.get(probe); } catch { continue; } // recorded as unanswered below
        answered.push(probe);
        results.set(probe, res);
        const hits = scan(res.body, asked);
        const known = KNOWN_EXPOSURES[template] ?? [];
        const unexpected = hits.filter((h) => !known.includes(h));
        if (unexpected.length > 0) leaks.push(`${probe} -> ${res.status}: ${unexpected.join(', ')}`);
        for (const k of known) if (hits.includes(k)) seenKnown.add(`${template}|${k}`);
      }
    }
    // Complete coverage: every route/parameter variant of the baseline was actually answered.
    expect(coverageProblems(expected, answered)).toEqual([]);
    expect(expected.length).toBeGreaterThan(100);
    expect(leaks).toEqual([]);
    const expectedKnown = Object.entries(KNOWN_EXPOSURES).flatMap(([t, ks]) => ks.map((k) => `${t}|${k}`)).sort();
    expect([...seenKnown].sort()).toEqual(expectedKnown);
    // Receiving any HTTP answer is not enough for the seeded privacy paths: each must answer 200 and
    // actually show the seeded row's public projection.
    expect(expectationProblems(SEEDED_EXPECTATIONS, results)).toEqual([]);
  }, 600_000);

  it('the DEFAULT (earnings) leaderboard answer leaks no seeded private value or full address (#1457 review)', async () => {
    // Every other probe here pins metric=submissions (backend#1456 made earnings the default). The
    // harness points core4 at a dead port, so the answer is the 503 "unavailable" body or, with a
    // node, a 200 ranking; either way an anonymous body must hold none of the seeded private values.
    const res = await app.get('/api/weather/leaderboard/');
    expect([200, 503]).toContain(res.status);
    expect(scan(res.body, [])).toEqual([]);
    for (const secret of [OWNER, OWNER.slice(2), '7777.4242', '4242.1717', 'Privatecity', 'h11-private@example.invalid', 'Private Place 99']) {
      expect(res.body.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(JSON.parse(res.body)).not.toHaveProperty('candidates'); // owner counts are operator/wallet only
  });

  it('the ownership-state read answers an anonymous caller by alias only and leaks no seeded private value (station theft protection)', async () => {
    // core4 is a dead port in the harness, so a real answer is the 503 "unavailable" body (never a
    // default "not frozen"); with a node it would be the explicit allowlisted projection. Either way
    // no seeded value, full address or coordinate may appear, and the raw station id is not an address.
    const byAlias = await app.get(`/api/stations/${aliasOfStation(STATION)}/ownership`);
    expect([200, 503]).toContain(byAlias.status);
    expect(scan(byAlias.body, [])).toEqual([]);
    for (const secret of [OWNER, OWNER.slice(2), STATION, '7777.4242', 'Test Street 1234', '10.123456', '20.654321']) {
      expect(byAlias.body.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    if (byAlias.status === 503) expect(JSON.parse(byAlias.body)).not.toHaveProperty('frozen');
    const byRawId = await app.get(`/api/stations/${STATION}/ownership`);
    expect(byRawId.status).toBe(404);
    expect(byRawId.body).not.toContain(STATION);
  });

  it('negative controls: an HTTP 500, an empty answer or a missing seeded row is reported by the expectation check', () => {
    const expectations = [{ url: '/api/iotex/devices', status: 200, contains: [DEVICE] }];
    const answer = (status: number, body: string) => new Map([['/api/iotex/devices', { status, body }]]);
    expect(expectationProblems(expectations, answer(200, `{"data":[{"id":"${DEVICE}"}]}`))).toEqual([]);
    expect(expectationProblems(expectations, answer(500, '{"error":"synthetic device outage"}'))).toEqual(['/api/iotex/devices: status 500, expected 200']);
    expect(expectationProblems(expectations, answer(200, '{"data":[]}'))).toEqual([`/api/iotex/devices: seeded value ${DEVICE} not in the answer`]);
    expect(expectationProblems(expectations, new Map())).toEqual(['/api/iotex/devices: no answer']);
  });

  it('negative control: a lost critical route is reported by the coverage check', () => {
    const expected = ['/api/iotex/devices', '/api/weather/stations'];
    expect(coverageProblems(expected, ['/api/weather/stations'])).toEqual(['/api/iotex/devices']);
    expect(coverageProblems(expected, expected)).toEqual([]);
  });

  it('no anonymous answer lets a caller that holds a full address match it to its leaderboard row (#1386)', async () => {
    // The raw address is in the request, so the address scan cannot catch this: the leak would be the
    // cross-response correlation address -> profile key -> public leaderboard row -> display name.
    const board = await app.get('/api/weather/leaderboard/?metric=submissions');
    const row = (JSON.parse(board.body).entries as Array<Record<string, unknown>>).find((e) => e.displayName === 'H11 Display 0.1,-0.2');
    expect(row).toBeDefined();
    expect(typeof row?.profileKey).toBe('string');
    for (const path of [`/api/operators/${OWNER}/profile`, `/api/operators/${OWNER}/og-meta`]) {
      const res = await app.get(path);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(row?.profileKey as string);
      expect(res.body).not.toContain('H11 Display');
    }
    const profile = JSON.parse((await app.get(`/api/operators/${OWNER}/profile`)).body).profile;
    expect(profile.profileKey).toBeNull();
    // the page the leaderboard links to still works, and shows only the short address
    const linked = await app.get(`/api/operators/${row?.profileKey}/profile`);
    expect(linked.status).toBe(200);
    expect(linked.body).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(JSON.parse(linked.body).profile.profileKey).toBe(row?.profileKey);
    // positive control: the operator bearer does get the key on the raw-address lookup
    const operator = JSON.parse((await app.get(`/api/operators/${OWNER}/profile`, { authorization: `Bearer ${OPERATOR}` })).body).profile;
    expect(operator.profileKey).toBe(row?.profileKey);
  });

  // Scope (lead ruling on #1397 r3): the anonymous rule covers stored station/user coordinates
  // and any echo of the CALLER's input. Third-party NWS prose (forecast text, alert areas and
  // descriptions, observation text) is public data and passes through unchanged. What this test
  // proves: the caller's fine coordinates appear nowhere in any answer, in any accepted form,
  // while the upstream prose (which carries a DIFFERENT pair) is delivered as sent.
  const CALLER_FINE = ['10.123456', '20.987654', '1.0123456e1', '2.0987654e1', '20.654321'];
  it('coordinate inputs: the caller\'s fine coordinates appear nowhere; upstream prose passes through (#1397)', async () => {
    const problems: string[] = [];
    for (const probe of COORDINATE_PROBES) {
      const res = await app.get(probe);
      if (res.status !== 200) { problems.push(`${probe}: status ${res.status} ${res.body.slice(0, 200)}`); continue; }
      for (const p of coordinateProblems(res.body)) problems.push(`${probe}: ${p}`);
      for (const re of FINE_COORD) if (re.test(res.body)) problems.push(`${probe}: ${String(re)}`);
      for (const fine of CALLER_FINE) if (res.body.includes(fine)) problems.push(`${probe}: caller value ${fine}`);
    }
    expect(problems).toEqual([]);
    // Not vacuous: the upstream text fields are present and carry their own pair unchanged.
    const data = JSON.parse((await app.get(`/api/weather/data/${C}`)).body);
    expect(data.current.data.conditions).toBe(`Clear near ${UPSTREAM_TEXT_PAIR}`);
    expect(data.current.metadata.rawMessage).toContain(UPSTREAM_TEXT_PAIR);
    const forecast = JSON.parse((await app.get(`/api/weather/forecast/${C}`)).body);
    expect(JSON.stringify(forecast)).toContain(`Clear near ${UPSTREAM_TEXT_PAIR}, light wind.`);
    // backend#1397 r5 (reviewer's production path): the NWS forecast period label is third-party
    // text and reaches an anonymous caller exactly as sent; only stored names are coarsened.
    expect(JSON.stringify(forecast)).toContain('"name":"Tonight 1.e-3"');
    // NWS station names pass through too (they carry the upstream pair, never the caller's).
    const nws = JSON.parse((await app.get(`/api/weather/stations?${Q}`)).body);
    expect(JSON.stringify(nws)).toContain(`at ${UPSTREAM_TEXT_PAIR}`);
    const alerts = JSON.parse((await app.get(`/api/weather/alerts/${C}`)).body);
    expect(alerts.alerts[0].areaDesc).toBe(`Fake County near ${UPSTREAM_TEXT_PAIR}`);
    expect(alerts.alerts[0].description).toContain(UPSTREAM_TEXT_PAIR);
    // Not vacuous: the echo is there, coarsened.
    expect(data.location).toEqual({ latitude: 10.1, longitude: -21, name: '10.1,-21.0' });
    // The name is rebuilt from the parsed, rounded coordinates, whatever form came in.
    for (const form of ['10.123456,-21', '1.0123456e1,-2.0987654e1', '+10.123456,-21']) {
      const echoed = JSON.parse((await app.get(`/api/weather/data/${form}`)).body).location;
      expect(echoed.name).toBe('10.1,-21.0');
    }
    const near = JSON.parse((await app.get('/api/weather/leaderboard/?metric=submissions&near=10.123456,20.654321&radius_km=25')).body);
    expect(near.near).toEqual(expect.objectContaining({ lat: 10.1, lng: 20.7 }));
  }, 120_000);

  it('coordinate inputs, positive control: an operator still gets the exact echo and upstream values', async () => {
    const operator = await app.get(`/api/weather/data/${C}`, { authorization: `Bearer ${OPERATOR}` });
    expect(operator.status).toBe(200);
    expect(JSON.parse(operator.body).location).toEqual({ latitude: 10.123456, longitude: -20.987654, name: C });
    expect(coordinateProblems(operator.body).length).toBeGreaterThan(0);
  });

  it('negative controls: the generic walker flags fine fields and pairs, and passes coarse ones', () => {
    expect(coordinateProblems(JSON.stringify({ a: { latitude: 10.12 } }))).toEqual(['$.a.latitude=10.12']);
    expect(coordinateProblems(JSON.stringify({ near: { lng: '20.65' } }))).toEqual(['$.near.lng=20.65']);
    expect(coordinateProblems(JSON.stringify({ geometry: { coordinates: [-20.98, 10.1] } }))).toEqual(['$.geometry.coordinates holds -20.98']);
    // Names are text: the walker leaves them to SEEDED_NAME_RAW (stored names) and to the
    // caller-value check (echoes); third-party names and labels pass (backend#1397 r5).
    expect(coordinateProblems(JSON.stringify({ name: 'Tonight 1.e-3' }))).toEqual([]);
    expect(scan(JSON.stringify({ name: 'H11 Station .10123456,-.20987654' }), [])).toEqual(['stored name with fine coordinates']);
    expect(scan(JSON.stringify({ name: 'H11 Station 0.1,-0.2' }), [])).toEqual([]);
    // Third-party prose is out of scope: not flagged.
    expect(coordinateProblems(JSON.stringify({ description: 'near 30.555555,-40.444444' }))).toEqual([]);
    expect(coordinateProblems('lat,lon\n10.12,-20.98')).toEqual(['coordinate pair in a non-JSON body']);
    // backend#1397 r2 forms: one fine axis, exponent, plus, in text and in fields.
    expect(coordinateProblems(JSON.stringify({ lat: '1.0123456e1' }))).toEqual(['$.lat=1.0123456e1']);
    expect(coordinateProblems(JSON.stringify({ name: '10.1,-21.0', lat: '1.01e1' }))).toEqual([]);
    expect(coordinateProblems(JSON.stringify({ latitude: 10.1, longitude: -21, name: '10.1,-21', temperature: 21.456, flat: 1.23 }))).toEqual([]);
  });

  // backend#1397 r6 (SOL-A): POST /api/iotex/devices answered 201 with the raw stored row. Since
  // backend#1399 (#1398) creation is operator/IoT-admin only, so an anonymous creator is refused and
  // gets nothing back; the 201 still goes through projectDevice (defense in depth), which hands a
  // privileged caller the stored row. A created device's stored name is coarsened for anonymous readers.
  it('POST /api/iotex/devices: anonymous is refused and echoes nothing; a created name is coarse to anonymous readers', async () => {
    const create = async (headers: Record<string, string>) => {
      const res = await fetch(`http://127.0.0.1:${app.port}/api/iotex/devices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          name: 'H11 Created .10123456,-.20987654',
          type: 'WEATHER_STATION',
          latitude: 10.123456,
          longitude: 20.654321,
          owner: '0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
          hardwareId: 'h11-created-hw',
        }),
      });
      return { status: res.status, body: await res.text() };
    };
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    const counter = new Pool({ connectionString: u.toString(), max: 1 });
    const rows = async () => ({
      devices: (await counter.query('SELECT COUNT(*)::int AS n FROM iotex_devices')).rows[0].n,
      attestations: (await counter.query('SELECT COUNT(*)::int AS n FROM iotex_attestation_requests')).rows[0].n,
    });
    try {
      const before = await rows();
      const anonymous = await create({});
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).not.toMatch(/H11 Created|\.10123456|10\.123456|20\.654321|e5e5e5e5|h11-created-hw/);
      expect(await rows()).toEqual(before); // refused before any write (backend#1398)

      // Both privileged creators (operator bearer, gateway admin token) are privileged readers too,
      // so projectDevice hands them the stored row: since W21 that row is at 0.1 degree.
      const created: string[] = [];
      for (const headers of [{ authorization: `Bearer ${OPERATOR}` }, { 'x-iot-gateway-admin-token': IOT_ADMIN }]) {
        const res = await create(headers);
        expect(res.status).toBe(201);
        const exact = JSON.parse(res.body).device;
        expect(exact.name).toBe('H11 Created .10123456,-.20987654');
        expect(exact.latitude).toBe(10.1);
        expect(exact.longitude).toBe(20.7);
        expect(exact.hardwareId).toBe('h11-created-hw');
        expect(typeof exact.manualAttestationRequired).toBe('boolean');
        created.push(exact.id);
      }
      expect(await rows()).toEqual({ devices: before.devices + 2, attestations: before.attestations + 2 });

      // The non-privileged view of a created device is the projection: an anonymous read by id.
      for (const id of created) {
        const read = await app.get(`/api/iotex/devices/${id}`);
        expect(read.status).toBe(200);
        const device = JSON.parse(read.body).device;
        expect(device.name).toBe('H11 Created 0.1,-0.2');
        expect(device.latitude).toBe(10.1);
        expect(device.longitude).toBe(20.7);
        for (const hidden of ['owner', 'publicKey', 'hardwareId', 'geohash', 'metadata']) {
          expect(device).not.toHaveProperty(hidden);
        }
        expect(read.body).not.toMatch(/\.10123456|10\.123456|20\.654321|e5e5e5e5|h11-created-hw/);
        expect(scan(read.body, [id])).toEqual([]);
      }
    } finally {
      await counter.end();
    }
  });

  it('positive control: the same seeded rows DO show exact coordinates to an operator (so a clean scan means something)', async () => {
    const anonymous = await app.get('/api/weather/stations');
    const operator = await app.get('/api/weather/stations', { authorization: `Bearer ${OPERATOR}` });
    expect(anonymous.status).toBe(200);
    expect(scan(anonymous.body, [])).toEqual([]);
    // backend#1397 r3: the seeded station name carries leading-dot coordinates; anonymous
    // callers get them at one decimal, operators get the name as stored.
    expect(anonymous.body).toContain('H11 Station 0.1,-0.2');
    expect(anonymous.body).not.toContain('.10123456');
    expect(operator.body).toContain('H11 Station .10123456,-.20987654');
    expect(operator.status).toBe(200);
    expect(scan(operator.body, []).length).toBeGreaterThan(0);
    expect(operator.body).toContain('10.123456'); // the coordinate marker itself, not only a private text field
    expect(scan(JSON.stringify({ latitude: 10.123456 }), [])).not.toEqual([]); // the scanner flags a JSON coordinate
  });
});
