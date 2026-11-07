/**
 * Make a forecast from the website (epic 7): the draft and submission checks, the one node client, the
 * routes and the reveal worker. The node is a fake. The flow tests run on real PostgreSQL when CI exports
 * BACKFILL_TEST_PG_URL (the partial unique index is the site cap, so a fake SQL layer would prove nothing).
 */
import express from 'express';
import request from 'supertest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  addressFromPublicKey, buildManifest, canonicalJson, checkSubmission, makeDraft, parseDraftInput, WEB_MODEL_ID,
} from '../server/services/website-forecast/website-forecast';
import {
  classifyNodeReply, createNodeForecastClient, NODE_COMMIT_PATH, NODE_REVEAL_PATH, type NodeForecastClient, type NodeSubmitResult,
} from '../server/services/website-forecast/node-forecast-client';
import { runRevealTick } from '../server/services/website-forecast/reveal-worker';
import { createWebsiteForecastRouter } from '../server/routes/website-forecast-routes';
import { forecastCommitId } from '../server/services/forecast-commit-record';
import type { Query } from '../server/services/forecast-verification/observed-verification';

const STATION = 'PWS-TEST-ALPHA-01';
const ALIAS = `st_${createHash('sha256').update(`wrfcoin-station-alias-v1:${STATION}`).digest('hex').slice(0, 12)}`;
const NOW = 1_800_000_000;

function wallet() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { pubkey: raw, address: addressFromPublicKey(raw) };
}
const SIG = 'ab'.repeat(64);

function draftFor(address: string, overrides: Partial<{ value: number; leadHours: 1 | 6 | 12 | 24; nowSec: number }> = {}) {
  return makeDraft({ stationAlias: ALIAS, variable: 'temperature_c', leadHours: overrides.leadHours ?? 6, value: overrides.value ?? 12.3,
    forecaster: address, stationId: STATION, nowSec: overrides.nowSec ?? NOW, nonce: 'web-0123456789abcdef0123456789abcdef' });
}
const submitBody = (d: ReturnType<typeof draftFor>, pubkey: string) =>
  ({ data: d.data, nonce: d.nonce, timestamp: d.timestamp, commitId: d.commitId, authPubkey: pubkey, authSignature: SIG });

describe('canonical forecast data', () => {
  it('matches serde_json::Value: sorted keys, compact, integral floats as integers', () => {
    expect(canonicalJson({ b: 1, a: { d: 12.0, c: -0 }, s: 'x' })).toBe('{"a":{"c":0,"d":12},"b":1,"s":"x"}');
    expect(() => canonicalJson({ v: Number.NaN })).toThrow();
    expect(() => canonicalJson({ v: 1e-9 })).toThrow();
  });

  it('builds the draft the browser signs: the commit id is the kit/core4 rule over this exact text', () => {
    const w = wallet();
    const d = draftFor(w.address, { value: 12.34 });
    expect(d.data).toBe(`{"horizon_hours":6,"issued_at":${NOW},"model_id":"${WEB_MODEL_ID}","station_id":"${STATION}","valid_at":${NOW + 6 * 3600},"values":{"temperature_c":12.3}}`);
    expect(d.commitId).toBe(forecastCommitId(d.data, d.nonce, STATION, NOW));
    expect(d).toMatchObject({ value: 12.3, validAt: NOW + 21600, timestamp: NOW, stationAlias: ALIAS });
  });

  it('writes the manifest in ForecastArtifactManifest declaration order with sha3 hashes', () => {
    const m = buildManifest({ data: '{}', stationId: STATION, issuedAt: NOW, horizonHours: 6, variable: 'pressure_hpa' });
    expect(Object.keys(m)).toEqual(['schema_version', 'model_id', 'input_hash', 'output_hash', 'produced_at', 'region', 'horizon_hours', 'input_variables', 'output_variables']);
    expect(m.output_hash).toBe(createHash('sha3-256').update('{}').digest('hex'));
    expect(m).toMatchObject({ region: STATION, input_variables: ['pressure_hpa'], output_variables: ['pressure_hpa'] });
  });

  it('refuses draft input outside the website rules', () => {
    expect(parseDraftInput({ stationAlias: ALIAS, variable: 'humidity_pct', leadHours: 6, value: 50 }).ok).toBe(false);
    expect(parseDraftInput({ stationAlias: ALIAS, variable: 'temperature_c', leadHours: 3, value: 5 }).ok).toBe(false);
    expect(parseDraftInput({ stationAlias: ALIAS, variable: 'temperature_c', leadHours: 6, value: 99 }).ok).toBe(false);
    expect(parseDraftInput({ stationAlias: STATION, variable: 'temperature_c', leadHours: 6, value: 5 }).ok).toBe(false);
    expect(parseDraftInput({ stationAlias: ALIAS, variable: 'pressure_hpa', leadHours: '24', value: '1013.26' }))
      .toEqual({ ok: true, value: { stationAlias: ALIAS, variable: 'pressure_hpa', leadHours: 24, value: 1013.3 } });
  });
});

describe('submission checks (before anything reaches the node)', () => {
  const w = wallet();
  const d = draftFor(w.address);

  it('accepts the signed draft of the logged-in wallet', () => {
    const r = checkSubmission(submitBody(d, w.pubkey), w.address, NOW + 30);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ forecaster: w.address, variable: 'temperature_c', value: 12.3, leadHours: 6, forecastDay: '2027-01-15' });
  });

  it('refuses a key that is not the wallet (forecaster == address(auth_pubkey))', () => {
    const other = wallet();
    expect(checkSubmission(submitBody(d, other.pubkey), w.address, NOW)).toMatchObject({ ok: false, status: 403, code: 'FORECASTER_MISMATCH' });
  });

  it('refuses a commit id that does not re-derive, and data that is not canonical', () => {
    expect(checkSubmission({ ...submitBody(d, w.pubkey), commitId: 'f'.repeat(64) }, w.address, NOW)).toMatchObject({ ok: false, code: 'COMMIT_MISMATCH' });
    const loose = d.data.replace('"horizon_hours":6,', '"horizon_hours": 6,');
    const body = { ...submitBody(d, w.pubkey), data: loose, commitId: forecastCommitId(loose, d.nonce, STATION, NOW) };
    expect(checkSubmission(body, w.address, NOW)).toMatchObject({ ok: false, code: 'INVALID_DATA' });
  });

  it('refuses a stale draft, an edited value and a foreign model id', () => {
    expect(checkSubmission(submitBody(d, w.pubkey), w.address, NOW + 16 * 60)).toMatchObject({ ok: false, code: 'DRAFT_EXPIRED' });
    const edited = d.data.replace('12.3', '12.34');
    expect(checkSubmission({ ...submitBody(d, w.pubkey), data: edited, commitId: forecastCommitId(edited, d.nonce, STATION, NOW) }, w.address, NOW))
      .toMatchObject({ ok: false, code: 'INVALID_DATA' });
    const kit = d.data.replace(WEB_MODEL_ID, 'persistence-trend/v1');
    expect(checkSubmission({ ...submitBody(d, w.pubkey), data: kit, commitId: forecastCommitId(kit, d.nonce, STATION, NOW) }, w.address, NOW))
      .toMatchObject({ ok: false, code: 'INVALID_DATA' });
  });
});

describe('node client (the one place the node request shape lives)', () => {
  it('sends the node ForecastCommitRequest / ForecastRevealRequest bodies', async () => {
    const calls: Array<[string, any]> = [];
    const client = createNodeForecastClient({
      post: async (path, body) => { calls.push([path, body]); return { ok: true, status: 202, payload: { ok: true, data: { tx_id: 'aa'.repeat(32) } } }; },
      get: async () => ({ ok: false, status: 404, payload: null }),
    });
    expect(await client.submitCommit({ forecaster: '0x' + '1'.repeat(40), station_id: STATION, commit_hash: 'c'.repeat(64), auth_pubkey: 'a'.repeat(64), auth_signature: SIG }))
      .toEqual({ kind: 'accepted', txHash: 'aa'.repeat(32) });
    expect(calls[0]).toEqual([NODE_COMMIT_PATH, { forecaster: '0x' + '1'.repeat(40), station_id: STATION, commit_hash: 'c'.repeat(64), auth_pubkey: 'a'.repeat(64), auth_signature: SIG }]);
    const manifest = buildManifest({ data: '{}', stationId: STATION, issuedAt: NOW, horizonHours: 6, variable: 'temperature_c' });
    await client.submitReveal({ forecaster: '0x' + '1'.repeat(40), station_id: STATION, payload: { a: 1 }, nonce: 'n', commit_hash: 'c'.repeat(64),
      timestamp: NOW, manifest, auth_pubkey: 'a'.repeat(64), auth_signature: SIG });
    expect(calls[1]).toEqual([NODE_REVEAL_PATH, { forecaster: '0x' + '1'.repeat(40), station_id: STATION, payload: { a: 1 }, nonce: 'n',
      commit_hash: 'c'.repeat(64), timestamp: NOW, manifest, auth_pubkey: 'a'.repeat(64), auth_signature: SIG }]);
    expect(await client.readStatus('c'.repeat(64))).toBeNull();
  });

  it('separates a refusal on the merits from an outage', () => {
    expect(classifyNodeReply({ ok: false, status: 422, payload: { ok: false, error: { code: 'INVALID_FORECAST_AUTHORIZATION', message: 'bad\nsig' } } }))
      .toEqual({ kind: 'refused', status: 422, code: 'INVALID_FORECAST_AUTHORIZATION', message: 'bad sig' });
    expect(classifyNodeReply({ ok: false, status: 403, payload: {} })).toEqual({ kind: 'unavailable', status: 403 });
    expect(classifyNodeReply({ ok: false, status: 403, payload: { ok: false, error: { code: 'FORECASTER_BEARER_UNBOUND', message: 'm' } } }))
      .toMatchObject({ kind: 'refused', status: 403, code: 'FORECASTER_BEARER_UNBOUND' });
    expect(classifyNodeReply({ ok: false, status: 503, payload: 'x' })).toEqual({ kind: 'unavailable', status: 503 });
  });
});

describe('switch off', () => {
  it('every path is 404 while WEBSITE_FORECAST_ENABLED is not true', async () => {
    delete process.env.WEBSITE_FORECAST_ENABLED;
    const a = express();
    a.use('/api/forecasts', createWebsiteForecastRouter({ query: async () => ({ rows: [] }), rateLimit: (_q, _s, n) => n() }));
    for (const path of ['/status', '/mine']) expect((await request(a).get(`/api/forecasts${path}`)).status).toBe(404);
    expect((await request(a).post('/api/forecasts/draft').send({})).status).toBe(404);
    expect((await request(a).post('/api/forecasts/submit').send({})).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------
// Real PostgreSQL: migrations 0039 + 0043 apply twice; draft -> submit -> worker reveal -> record filed.
// ---------------------------------------------------------------------------------------------------
const PG_URL = process.env.BACKFILL_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('website forecast flow on real PostgreSQL', () => {
  const postgres = require('postgres');
  const { readFileSync } = require('node:fs');
  const schema = `wf_0043_${process.pid}`;
  let sql: any;
  let query: Query;
  let clock = NOW * 1000;
  const w = wallet();

  type Reply = NodeSubmitResult;
  const node = {
    commits: [] as any[], reveals: [] as any[], commitReply: { kind: 'accepted', txHash: 'aa'.repeat(32) } as Reply,
    revealReply: { kind: 'accepted', txHash: 'bb'.repeat(32) } as Reply, status: null as Record<string, any> | null,
  };
  const fakeNode: NodeForecastClient = {
    submitCommit: async (r) => { node.commits.push(r); return node.commitReply; },
    submitReveal: async (r) => { node.reveals.push(r); return node.revealReply; },
    readStatus: async () => node.status,
  };
  const app = () => {
    const a = express();
    a.use('/api/forecasts', createWebsiteForecastRouter({
      query, node: fakeNode, now: () => clock, rateLimit: (_q, _s, n) => n(),
      authenticate: (req: any, _res, next) => { req.user = { address: w.address }; next(); },
    }));
    return a;
  };
  const tick = () => runRevealTick({ query, node: fakeNode, now: () => clock, minIntervalS: 0 });

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe('CREATE TABLE weather_stations (station_id text NOT NULL UNIQUE, latitude double precision, longitude double precision)');
    await sql.unsafe(`INSERT INTO weather_stations (station_id, latitude, longitude) VALUES ('${STATION}', 46.8, -92.1)`);
    for (const file of ['0039_forecast_verification', '0043_website_forecasts']) {
      const migration = readFileSync(`drizzle/migrations/${file}.sql`, 'utf8');
      for (let i = 0; i < 2; i += 1) for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
    }
    query = async (text, params = []) => ({ rows: await sql.unsafe(text, params as any[]) });
  });
  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });
  beforeEach(() => { process.env.WEBSITE_FORECAST_ENABLED = 'true'; });

  async function signedDraft(leadHours = 6) {
    const res = await request(app()).post('/api/forecasts/draft').send({ stationAlias: ALIAS, variable: 'temperature_c', leadHours, value: 7.25 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ forecaster: w.address, stationAlias: ALIAS, value: 7.3, leadHours });
    return res.body;
  }

  it('relays a commit, reveals in the next block, files the record, and lists it as the wallet\'s', async () => {
    expect((await request(app()).get('/api/forecasts/status')).body).toEqual({ enabled: true, leads: [1, 6, 12, 24], variables: ['temperature_c', 'pressure_hpa'] });
    const d = await signedDraft();
    const sub = await request(app()).post('/api/forecasts/submit').send(submitBody(d, w.pubkey));
    expect(sub.status).toBe(202);
    expect(sub.body).toEqual({ commitId: d.commitId, status: 'committed', commitTxHash: 'aa'.repeat(32), stationAlias: ALIAS, issuedAt: d.issuedAt, validAt: d.validAt });
    expect(node.commits[0]).toEqual({ forecaster: w.address, station_id: STATION, commit_hash: d.commitId, auth_pubkey: w.pubkey, auth_signature: SIG });

    // One per wallet, station, lead and day: the first one keeps the slot.
    const again = await request(app()).post('/api/forecasts/draft').send({ stationAlias: ALIAS, variable: 'pressure_hpa', leadHours: 6, value: 1000 });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ALREADY_FORECAST', commitId: d.commitId });

    // Commit still in the mempool: nothing to do yet.
    node.status = null;
    await tick();
    expect(node.reveals).toHaveLength(0);

    // In a block: the worker reveals with the stored package.
    node.status = { commit_id: d.commitId, contribution_type: 'forecast', station_id: STATION, status: 'committed_pending_reveal', committed_at: 9001 };
    clock += 80_000;
    expect(await tick()).toMatchObject({ revealSent: 1 });
    expect(node.reveals[0]).toMatchObject({ forecaster: w.address, station_id: STATION, nonce: d.nonce, commit_hash: d.commitId, timestamp: d.timestamp,
      auth_pubkey: w.pubkey, auth_signature: SIG,
      payload: JSON.parse(d.data), manifest: { schema_version: 1, model_id: WEB_MODEL_ID, region: STATION, horizon_hours: 6, input_variables: ['temperature_c'] } });
    // The node rebuilds the commit id from the payload object: it must reproduce the commit hash.
    expect(forecastCommitId(canonicalJson(node.reveals[0].payload), d.nonce, STATION, d.timestamp)).toBe(d.commitId);

    node.status = { ...node.status, status: 'revealed_pending_attestation', revealed_at: 9002 };
    clock += 80_000;
    expect(await tick()).toMatchObject({ revealed: 1, filed: 1 });
    const record = (await query('SELECT station_alias, model_id, horizon_hours, forecast_values, status FROM forecast_verification_records WHERE commit_id = $1', [d.commitId])).rows[0];
    expect(record).toMatchObject({ station_alias: ALIAS, model_id: WEB_MODEL_ID, horizon_hours: 6, status: 'pending' });

    const mine = await request(app()).get('/api/forecasts/mine');
    expect(mine.body.forecasts[0]).toMatchObject({ commitId: d.commitId, stationAlias: ALIAS, variable: 'temperature_c', value: 7.3, leadHours: 6,
      status: 'revealed', committedAtHeight: 9001, revealedAtHeight: 9002, commitTxHash: 'aa'.repeat(32), revealTxHash: 'bb'.repeat(32),
      score: { status: 'pending' } });
    expect(JSON.stringify(mine.body)).not.toContain(STATION);
  });

  it('a commit the node refuses frees the slot; a missed reveal window fails the forecast', async () => {
    node.commitReply = { kind: 'refused', status: 422, code: 'INVALID_FORECAST_AUTHORIZATION', message: 'bad signature' };
    const d = await signedDraft(12);
    const sub = await request(app()).post('/api/forecasts/submit').send(submitBody(d, w.pubkey));
    expect(sub.status).toBe(422);
    expect(sub.body.error).toMatchObject({ code: 'NODE_REFUSED', nodeCode: 'INVALID_FORECAST_AUTHORIZATION' });

    node.commitReply = { kind: 'accepted', txHash: null };
    const d2 = await signedDraft(12);
    expect((await request(app()).post('/api/forecasts/submit').send(submitBody(d2, w.pubkey))).status).toBe(202);
    node.status = { commit_id: d2.commitId, contribution_type: 'forecast', station_id: STATION, status: 'committed_pending_reveal', committed_at: 9100 };
    node.revealReply = { kind: 'unavailable', status: 503 };
    await tick();
    clock += 9 * 60_000;
    await tick();
    const row = (await query('SELECT status, failure FROM website_forecasts WHERE commit_id = $1', [d2.commitId])).rows[0];
    expect(row).toEqual({ status: 'failed', failure: 'reveal_window_missed' });
  });
});
