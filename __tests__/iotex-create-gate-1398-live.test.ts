/**
 * backend#1398, live entrypoint + real Postgres: an anonymous POST
 * /api/iotex/devices is refused and writes nothing (no iotex_devices row, no
 * iotex_attestation_requests row); the operator bearer still creates a device and
 * its attestation request. Boots server/enhanced_unified_api_optimized.ts
 * against a throwaway database (see helpers/anonymous-get-harness.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { bootLiveEntrypoint, type Booted } from './helpers/anonymous-get-harness';
import { dropThrowawayDatabase } from './helpers/throwaway-db';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;
if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('the live iotex create-gate test would have been skipped');
  });
}

// The harness boots the entrypoint with this operator token.
const OPERATOR = 'test-operator-h11-0123456789abcdef';
const BODY = {
  name: 'Fake sensor 1398',
  type: 'WEATHER_STATION',
  latitude: 10.0,
  longitude: 20.0,
  owner: '0xf6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6',
};

d('POST /api/iotex/devices on the live entrypoint (backend#1398)', () => {
  const dbName = `iotex1398_${process.pid}_${Date.now().toString(36)}`;
  let admin: Pool;
  let db: Pool;
  let app: Booted;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();
    db = new Pool({ connectionString: dbUrl, max: 1 });
    const dir = path.join(__dirname, '../drizzle/migrations');
    for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
      await db.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    app = await bootLiveEntrypoint(dbUrl);
  }, 240_000);

  afterAll(async () => {
    try {
      await app?.stop();
    } finally {
      // Wait for db's session to go away before the FORCE drop (backend#1402).
      try { await dropThrowawayDatabase(admin, dbName, [db]); } finally { await admin?.end(); }
    }
  });

  const counts = async () => {
    const devices = await db.query('SELECT COUNT(*)::int AS n FROM iotex_devices');
    const attestations = await db.query('SELECT COUNT(*)::int AS n FROM iotex_attestation_requests');
    return { devices: devices.rows[0].n as number, attestations: attestations.rows[0].n as number };
  };
  const create = async (headers: Record<string, string>) => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/iotex/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(BODY),
    });
    return { status: res.status, body: await res.text() };
  };

  it('an anonymous or wrongly-authenticated POST is refused and writes nothing', async () => {
    const before = await counts();
    for (const headers of [{}, { authorization: 'Bearer not-the-operator' }, { 'x-iot-gateway-admin-token': 'guess' }]) {
      const res = await create(headers);
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({
        success: false,
        message: 'Operator or IoT gateway admin authorization required',
        code: 'OPERATOR_AUTH_REQUIRED',
      });
    }
    expect(await counts()).toEqual(before);
  });

  it('the refusal matches anonymous PUT /devices/:id on the same server', async () => {
    const put = await fetch(`http://127.0.0.1:${app.port}/api/iotex/devices/device-none`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    const post = await create({});
    expect(post.status).toBe(put.status);
    expect(post.body).toBe(await put.text());
  });

  it('the operator bearer still creates a device and its attestation request (201)', async () => {
    const before = await counts();
    const res = await create({ authorization: `Bearer ${OPERATOR}` });
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.device.name).toBe('Fake sensor 1398');
    expect(await counts()).toEqual({ devices: before.devices + 1, attestations: before.attestations + 1 });
  });
});
