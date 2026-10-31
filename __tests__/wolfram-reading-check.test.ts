/**
 * Bring-your-own-key Wolfram reading check (owner ruling 2026-11-01):
 * POST /api/integrations/wolfram/reading-check relays ONE fixed question with the caller's own
 * AppID. Default OFF; the key is never stored, logged, echoed or put in an error; nothing cached.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  buildQuery,
  createWolframReadingCheckRouter,
  extractRange,
  judge,
  parseInput,
  readPods,
  type WolframFetch,
} from '../server/routes/wolfram-reading-check-routes';

const APPID = 'ABC123-DEF456GHIJ7';
const body = (over: Record<string, unknown> = {}) => ({
  appId: APPID,
  latitude: 46.83,
  longitude: -92.04,
  date: '2026-10-31',
  temperatureC: 8,
  ...over,
});

const answer = (pods: Array<{ title: string; text: string }>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    queryresult: {
      success: true,
      error: false,
      pods: pods.map((p) => ({ title: p.title, subpods: [{ plaintext: p.text }] })),
      ...extra,
    },
  });

const HISTORICAL = answer([
  { title: 'Input interpretation', text: 'temperature | October 31 | Duluth, Minnesota' },
  {
    title: 'Historical temperatures for October 31',
    text: 'low: -12 °C (1991) | average low: -1 °C | average high: 9 °C | high: 22 °C (1950)',
  },
]);

type Call = { url: string; headers: Record<string, string> };

function app(fetchImpl: WolframFetch, opts: { now?: () => number; withAppRaw?: boolean } = {}) {
  const a = express();
  // Same order as the deployed entrypoint: the raw parser for this path runs before the global JSON parser.
  if (opts.withAppRaw !== false) a.use('/api/integrations/wolfram/reading-check', express.raw({ type: () => true, limit: 2048 }));
  a.use(express.json({ limit: '1mb' }));
  const passThrough: express.RequestHandler = (_req, _res, next) => next();
  a.use('/api/integrations/wolfram', createWolframReadingCheckRouter({ fetchImpl, rateLimit: passThrough, now: opts.now }));
  return a;
}

function upstream(reply: { status?: number; text?: string } | Error) {
  const calls: Call[] = [];
  const fetchImpl: WolframFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (reply instanceof Error) throw reply;
    return { ok: (reply.status ?? 200) < 300, status: reply.status ?? 200, text: async () => reply.text ?? '' };
  };
  return { calls, fetchImpl };
}

describe('POST /api/integrations/wolfram/reading-check', () => {
  const saved = { ...process.env };
  let logSpies: Array<ReturnType<typeof jest.spyOn>> = [];
  beforeEach(() => {
    process.env.WOLFRAM_READING_CHECK_ENABLED = 'true';
    delete process.env.WOLFRAM_READING_CHECK_UPSTREAM_MAX_PER_MIN;
    logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterEach(() => {
    process.env = { ...saved };
    for (const s of logSpies) s.mockRestore();
  });
  const logged = () => logSpies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).join('\n');

  it('is 404 and asks nothing upstream unless WOLFRAM_READING_CHECK_ENABLED=true exactly', async () => {
    for (const value of [undefined, 'TRUE', '1', 'yes']) {
      if (value === undefined) delete process.env.WOLFRAM_READING_CHECK_ENABLED;
      else process.env.WOLFRAM_READING_CHECK_ENABLED = value;
      const { calls, fetchImpl } = upstream({ text: HISTORICAL });
      const res = await request(app(fetchImpl)).post('/api/integrations/wolfram/reading-check').send(body());
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
  });

  it('asks the one fixed question with the caller AppID and returns a verdict with the attribution link', async () => {
    const { calls, fetchImpl } = upstream({ text: HISTORICAL });
    const res = await request(app(fetchImpl)).post('/api/integrations/wolfram/reading-check').send(body());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.verdict).toBe('typical');
    expect(res.body.reference).toEqual({ typicalLowC: -1, typicalHighC: 9, recordLowC: -12, recordHighC: 22, averageC: null });
    expect(res.body.query).toBe('historical temperatures on October 31 at 46.8°N 92.0°W');
    expect(res.body.resultsUrl).toBe(`https://www.wolframalpha.com/input?i=${encodeURIComponent(res.body.query)}`);
    expect(res.body.place).toEqual({ latitude: 46.8, longitude: -92 });
    expect(res.body.pod.title).toBe('Historical temperatures for October 31');

    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.wolframalpha.com/v2/query');
    expect(u.searchParams.get('appid')).toBe(APPID);
    expect(u.searchParams.get('input')).toBe(res.body.query);
    expect(u.searchParams.get('output')).toBe('json');
    // No caller header (cookie, authorization, forwarded address) reaches Wolfram.
    expect(Object.keys(calls[0].headers)).toEqual(['accept']);

    // The key never comes back and is never logged.
    expect(JSON.stringify(res.body)).not.toContain(APPID);
    expect(logged()).not.toContain(APPID);
  });

  it('is not a general proxy: free text in the body never reaches the upstream question', async () => {
    const { calls, fetchImpl } = upstream({ text: HISTORICAL });
    const res = await request(app(fetchImpl))
      .post('/api/integrations/wolfram/reading-check')
      .send(body({ input: 'integrate x^2', query: 'population of France', code: 'Run["rm"]' }));
    expect(res.status).toBe(200);
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('input')).toBe('historical temperatures on October 31 at 46.8°N 92.0°W');
    expect(calls[0].url).not.toMatch(/France|integrate|Run/);
  });

  it.each([
    ['unusual (outside the typical range, inside the records)', 15, 'unusual'],
    ['outside the record range', 30, 'outside_record'],
    ['typical', 3, 'typical'],
  ])('judges a reading as %s', async (_label, temperatureC, verdict) => {
    const { fetchImpl } = upstream({ text: HISTORICAL });
    const res = await request(app(fetchImpl)).post('/api/integrations/wolfram/reading-check').send(body({ temperatureC }));
    expect(res.body.verdict).toBe(verdict);
  });

  it('answers unknown (never a guess) when Wolfram has no readable range', async () => {
    const { fetchImpl } = upstream({ text: answer([{ title: 'Result', text: 'October 31 is a Saturday' }]) });
    const res = await request(app(fetchImpl)).post('/api/integrations/wolfram/reading-check').send(body());
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('unknown');
    expect(res.body.reference).toBeNull();
    expect(res.body.resultsUrl).toContain('wolframalpha.com/input');

    const none = upstream({ text: JSON.stringify({ queryresult: { success: false, error: false, numpods: 0 } }) });
    const res2 = await request(app(none.fetchImpl)).post('/api/integrations/wolfram/reading-check').send(body());
    expect(res2.body.verdict).toBe('unknown');
  });

  it('maps a rejected AppID to 401 without echoing the key or the upstream text', async () => {
    const rejected = JSON.stringify({ queryresult: { success: false, error: { code: '1', msg: `Invalid appid ${APPID}` } } });
    for (const reply of [{ text: rejected }, { status: 403, text: `Error 1: Invalid appid ${APPID}` }]) {
      const { fetchImpl } = upstream(reply);
      const res = await request(app(fetchImpl)).post('/api/integrations/wolfram/reading-check').send(body());
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('WOLFRAM_APPID_REJECTED');
      expect(JSON.stringify(res.body)).not.toContain(APPID);
    }
  });

  it('maps upstream failures to 502/504/429 and never a verdict', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cases: Array<[Parameters<typeof upstream>[0], number]> = [
      [timeout, 504],
      [new Error(`connect ECONNREFUSED appid=${APPID}`), 502],
      [{ status: 500, text: 'oops' }, 502],
      [{ status: 429, text: '' }, 429],
      [{ text: 'not json' }, 502],
    ];
    for (const [reply, status] of cases) {
      const { fetchImpl } = upstream(reply);
      const res = await request(app(fetchImpl)).post('/api/integrations/wolfram/reading-check').send(body());
      expect(res.status).toBe(status);
      expect(res.body.verdict).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(APPID);
    }
    expect(logged()).not.toContain(APPID);
  });

  it('validates every field and never quotes a malformed body back', async () => {
    const { calls, fetchImpl } = upstream({ text: HISTORICAL });
    const a = app(fetchImpl);
    const bad: Array<Record<string, unknown>> = [
      { appId: 'has space-1234' },
      { appId: 'ABC123-DEF456&input=x' },
      { appId: undefined },
      { latitude: 91 },
      { longitude: '10' },
      { temperatureC: 75 },
      { date: '2026-02-30' },
      { date: '31/10/2026' },
    ];
    for (const over of bad) {
      const res = await request(a).post('/api/integrations/wolfram/reading-check').send(body(over));
      expect(res.status).toBe(400);
    }
    const malformed = await request(a)
      .post('/api/integrations/wolfram/reading-check')
      .set('content-type', 'application/json')
      .send(`{"appId":"${APPID}",`);
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toContain(APPID);
    const big = await request(a)
      .post('/api/integrations/wolfram/reading-check')
      .set('content-type', 'application/json')
      .send(JSON.stringify(body({ pad: 'x'.repeat(4000) })));
    expect(big.status).toBe(413);
    const form = await request(a).post('/api/integrations/wolfram/reading-check').type('form').send(`appId=${APPID}`);
    expect(form.status).toBe(415);
    expect(calls).toHaveLength(0);
    expect(logged()).not.toContain(APPID);
  });

  it('caps upstream calls for the whole process and says when to retry', async () => {
    process.env.WOLFRAM_READING_CHECK_UPSTREAM_MAX_PER_MIN = '2';
    let clock = 1_000_000;
    const { calls, fetchImpl } = upstream({ text: HISTORICAL });
    const a = app(fetchImpl, { now: () => clock });
    const post = () => request(a).post('/api/integrations/wolfram/reading-check').send(body());
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const third = await post();
    expect(third.status).toBe(503);
    expect(third.body.error.code).toBe('UPSTREAM_BUDGET_EXHAUSTED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    clock += 60_000;
    expect((await post()).status).toBe(200);
  });
});

describe('reading-check helpers', () => {
  it('coarsens the place to 0.1 degree and writes hemispheres', () => {
    const p = parseInput(body({ latitude: -33.8688, longitude: 151.2093 }));
    expect(p.ok && p.value).toMatchObject({ latitude: -33.9, longitude: 151.2, month: 10, day: 31 });
    expect(buildQuery({ latitude: -33.9, longitude: 151.2, month: 2, day: 29 })).toBe('historical temperatures on February 29 at 33.9°S 151.2°E');
  });

  it('reads labelled, piped, range and Fahrenheit plaintext', () => {
    expect(extractRange('average high | 8 °C\naverage low | −1 °C')).toEqual({
      typicalLowC: -1, typicalHighC: 8, recordLowC: null, recordHighC: null, averageC: null,
    });
    expect(extractRange('-3 °C to 14 °C (average: 6 °C)')).toEqual({
      typicalLowC: null, typicalHighC: null, recordLowC: -3, recordHighC: 14, averageC: 6,
    });
    expect(extractRange('low: 14 °F | average low: 30 °F | average high: 47 °F | high: 75 °F')).toEqual({
      typicalLowC: -1.1, typicalHighC: 8.3, recordLowC: -10, recordHighC: 23.9, averageC: null,
    });
    expect(extractRange('no numbers here')).toBeNull();
  });

  it('judges only from what Wolfram said', () => {
    expect(judge(5, null)).toBe('unknown');
    expect(judge(5, { typicalLowC: null, typicalHighC: null, recordLowC: -3, recordHighC: 14, averageC: 6 })).toBe('typical');
    expect(judge(20, { typicalLowC: null, typicalHighC: null, recordLowC: -3, recordHighC: 14, averageC: 6 })).toBe('outside_record');
    expect(judge(5, { typicalLowC: null, typicalHighC: null, recordLowC: null, recordHighC: null, averageC: 6 })).toBe('unknown');
  });

  it('separates a rejected key from an empty answer', () => {
    expect(readPods('{"queryresult":{"success":false,"error":{"code":"1","msg":"Invalid appid"}}}').kind).toBe('rejected');
    expect(readPods('{"queryresult":{"success":false,"error":false}}').kind).toBe('no_result');
    expect(readPods('<xml/>').kind).toBe('malformed');
  });
});
