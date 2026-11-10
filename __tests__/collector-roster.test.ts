/**
 * The collector's roster for website stations that are registered on chain
 * (server/services/collector-roster.ts). Made-up stations, wallets, devices,
 * positions and keys only.
 */
import { describe, expect, it } from '@jest/globals';
import { encryptData } from '../server/utils/crypto';
import {
  COLLECTOR_ROSTER_SQL,
  COLLECTOR_ROSTER_VERSION,
  DEFAULT_ROSTER_MODEL,
  MAX_COLLECTOR_ROSTER_ENTRIES,
  collectorRosterEnabled,
  listCollectorRoster,
  rosterMac,
} from '../server/services/collector-roster';

const ENC_KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const API_KEY = 'APIKEY-fixture-0000000000000000000000000000000000000000000000000000';
const APP_KEY = 'APPKEY-fixture-0000000000000000000000000000000000000000000000000000';
const OWNER = `0x${'1a'.repeat(20)}`;

function row(over: Record<string, unknown> = {}, keys: { api?: string; app?: string; key?: string } = {}) {
  const api = encryptData(keys.api ?? API_KEY, keys.key ?? ENC_KEY);
  const app = encryptData(keys.app ?? APP_KEY, keys.key ?? ENC_KEY);
  return {
    station_id: 'pws-00000000000000a1', owner_address: OWNER,
    latitude: 10 + 1 / 3, longitude: -(20 + 2 / 3),
    metadata: { mac: 'aa:bb:cc:dd:ee:01', hardware: 'WS-2902', ingestionStatus: 'active' },
    encrypted_api_key: api.encrypted, key_iv: api.iv, key_tag: api.tag,
    encrypted_app_key: app.encrypted, app_iv: app.iv, app_tag: app.tag,
    ...over,
  };
}
function poolOf(rows: unknown[]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return { calls, query: async (text: string, params?: unknown[]) => { calls.push({ text, params }); return { rows }; } };
}

describe('collectorRosterEnabled', () => {
  it('is off unless the switch is exactly "true"', () => {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
      expect(collectorRosterEnabled({ COLLECTOR_ROSTER_ENABLED: value })).toBe(false);
    }
    expect(collectorRosterEnabled({ COLLECTOR_ROSTER_ENABLED: 'true' })).toBe(true);
  });
});

describe('who is on the roster (decided in the SQL)', () => {
  it('only stations registered on chain, active, still the signer\'s, with ambient credentials; it reads and never writes', () => {
    const sql = COLLECTOR_ROSTER_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain("r.status = 'on_chain'");
    expect(sql).toContain('w.is_active = true');
    expect(sql).toContain('lower(w.owner_address) = r.owner_address');
    expect(sql).toContain("JOIN station_provider_credentials c ON c.station_id = w.station_id AND c.provider = 'ambient'");
    expect(sql).toMatch(/^SELECT /);
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/i);
    // No name, location text or owner free text is even selected.
    expect(sql).not.toMatch(/w\.name|w\.location|station_type/);
  });

  it('asks for one row more than the cap, and serves at most the cap', async () => {
    const many = Array.from({ length: MAX_COLLECTOR_ROSTER_ENTRIES + 1 }, (_, i) => row({
      station_id: `pws-${i.toString(16).padStart(16, '0')}`,
      metadata: { mac: i.toString(16).padStart(12, '0') },
    }));
    const pool = poolOf(many);
    const roster = await listCollectorRoster(pool, ENC_KEY);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].params).toEqual([MAX_COLLECTOR_ROSTER_ENTRIES + 1]);
    expect(roster.stations).toHaveLength(MAX_COLLECTOR_ROSTER_ENTRIES);
    expect(roster.skipped).toBe(1);
  });
});

describe('what an entry holds', () => {
  it('exactly the fields the collector needs, with the keys decrypted and the position on the 0.1 degree grid', async () => {
    const roster = await listCollectorRoster(poolOf([row({ metadata: { mac: 'AA-BB-CC-DD-EE-01', hardware: 'WS-2902', elevation_m: 227.5 } })]), ENC_KEY);
    expect(roster).toEqual({
      version: COLLECTOR_ROSTER_VERSION,
      skipped: 0,
      stations: [{
        provider: 'ambient',
        stationId: 'pws-00000000000000a1',
        ownerAddress: OWNER,
        mac: 'AA:BB:CC:DD:EE:01',
        model: 'WS-2902',
        consentStatus: 'approved',
        coarseMetadataStatus: 'approved',
        bindingRef: 'backend:website-station:pws-00000000000000a1',
        apiKey: API_KEY,
        appKey: APP_KEY,
        latitude: 10.3,
        longitude: -20.7,
        elevation_m: 227.5,
      }],
    });
  });

  it('never sends a position finer than 0.1 degree, whatever the row holds, and never "-0"', async () => {
    for (const [lat, lon, wantLat, wantLon] of [
      [10.3456789, -20.6543211, 10.3, -20.7], ['44.95', '-93.04', 45, -93], [-0.04, 0.04, 0, 0], [89.96, 179.96, 90, 180],
    ] as Array<[unknown, unknown, number, number]>) {
      const { stations } = await listCollectorRoster(poolOf([row({ latitude: lat, longitude: lon })]), ENC_KEY);
      expect([stations[0].latitude, stations[0].longitude]).toEqual([wantLat, wantLon]);
      expect(Object.is(stations[0].latitude, -0) || Object.is(stations[0].longitude, -0)).toBe(false);
      for (const v of [stations[0].latitude, stations[0].longitude]) expect(Number.isInteger(Number((v * 10).toFixed(6)))).toBe(true);
    }
  });

  it('passes the collector\'s own roster rules: allowed fields only in the checked part, a label for bindingRef, a full MAC', async () => {
    const { stations } = await listCollectorRoster(poolOf([row()]), ENC_KEY);
    const entry = stations[0];
    // core4 tests/security/lib/ambient-roster-verifier.cjs
    expect(entry.mac).toMatch(/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i);
    expect(entry.bindingRef).not.toMatch(/^(?:[0-9a-f]{32,}|[A-Za-z0-9+/]{32,}={0,2})$/);
    expect(entry.bindingRef).not.toContain(API_KEY);
    expect(entry.model.length).toBeGreaterThan(0);
    expect(Object.keys(entry).sort()).toEqual([
      'apiKey', 'appKey', 'bindingRef', 'coarseMetadataStatus', 'consentStatus', 'latitude', 'longitude',
      'mac', 'model', 'ownerAddress', 'provider', 'stationId',
    ]);
  });

  it('no hardware picked, or one that is not plain text: the chain record\'s model; metadata stored as text is read too', async () => {
    for (const hardware of [undefined, '', '   ', 'x'.repeat(129), 'WS\u0000-2902', 42]) {
      const { stations } = await listCollectorRoster(poolOf([row({ metadata: { mac: 'aa:bb:cc:dd:ee:01', hardware } })]), ENC_KEY);
      expect(stations[0].model).toBe(DEFAULT_ROSTER_MODEL);
    }
    const { stations } = await listCollectorRoster(poolOf([row({ metadata: JSON.stringify({ mac: 'aabbccddee01', hardware: 'WS-5000' }) })]), ENC_KEY);
    expect(stations[0]).toMatchObject({ mac: 'AA:BB:CC:DD:EE:01', model: 'WS-5000' });
  });
});

describe('a row that cannot be a complete entry is left out alone', () => {
  const good = row({ station_id: 'pws-00000000000000b2', metadata: { mac: 'aa:bb:cc:dd:ee:02' } });

  it('no device, a malformed device, no position, a bad id or owner, keys that cannot be read, a missing application key', async () => {
    const bad = [
      row({ metadata: {} }), row({ metadata: { mac: 'aa:bb:cc' } }), row({ metadata: { mac: 'zz:bb:cc:dd:ee:01' } }),
      row({ metadata: 'not json' }), row({ metadata: null }),
      row({ latitude: null }), row({ longitude: 'abc' }), row({ latitude: 91 }), row({ longitude: -181 }),
      row({ station_id: 'bad id' }), row({ owner_address: OWNER.toUpperCase() }), row({ owner_address: 'nobody' }),
      row({}, { key: OTHER_KEY }),
      row({ encrypted_app_key: null, app_iv: null, app_tag: null }),
      row({ key_tag: '00'.repeat(16) }),
    ];
    for (const one of bad) {
      const roster = await listCollectorRoster(poolOf([one, good]), ENC_KEY);
      expect(roster.stations.map((s) => s.stationId)).toEqual(['pws-00000000000000b2']);
      expect(roster.skipped).toBe(1);
    }
  });

  it('two stations on one device: only the first is sent', async () => {
    const roster = await listCollectorRoster(poolOf([row(), row({ station_id: 'pws-00000000000000c3', metadata: { mac: 'AABBCCDDEE01' } })]), ENC_KEY);
    expect(roster.stations.map((s) => s.stationId)).toEqual(['pws-00000000000000a1']);
    expect(roster.skipped).toBe(1);
  });

  it('nothing registered on chain: an empty roster, not an error', async () => {
    expect(await listCollectorRoster(poolOf([]), ENC_KEY)).toEqual({ version: COLLECTOR_ROSTER_VERSION, stations: [], skipped: 0 });
  });
});

describe('rosterMac', () => {
  it('accepts the usual spellings of twelve hex digits and nothing else', () => {
    for (const ok of ['aa:bb:cc:dd:ee:01', 'AA-BB-CC-DD-EE-01', 'aabbccddee01', ' aa:bb:cc:dd:ee:01 ']) {
      expect(rosterMac(ok)).toBe('AA:BB:CC:DD:EE:01');
    }
    for (const bad of [undefined, null, 12, '', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:01:02', 'gg:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:01;x']) {
      expect(rosterMac(bad)).toBeNull();
    }
  });
});
