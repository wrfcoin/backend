/**
 * "Is this reading unusual?" with the caller's OWN Wolfram|Alpha AppID (owner ruling 2026-11-01:
 * bring your own key, never a shared server key, never hold anyone's API key).
 *
 *   POST /api/integrations/wolfram/reading-check
 *   body  { appId, latitude, longitude, date: "YYYY-MM-DD", temperatureC }
 *   200   { verdict, temperatureC, reference, pod, query, resultsUrl, attribution }
 *
 * Why a pass-through at all: the Wolfram|Alpha API answers browsers without an
 * Access-Control-Allow-Origin header (measured 2026-10-31 on /v2/query, /v1/result and the LLM API),
 * so a page on wrfcoin.com cannot call it directly. This route is the thinnest possible relay:
 *   - the AppID arrives in the JSON body (never the URL or a header, so no access log records it),
 *     is used for exactly one upstream request, and is then dropped: it is never stored, cached,
 *     logged, echoed back, or put in an error message;
 *   - it is NOT a general Wolfram proxy: the caller supplies numbers only (a 0.1-degree place, a
 *     calendar day, a temperature) and the server writes the one fixed question asked upstream, so
 *     a key cannot be used through this route for anything else, and there is no code execution;
 *   - nothing is cached (Wolfram|Alpha API terms forbid caching results) and every answer carries a
 *     link to the Wolfram|Alpha results page (the terms require that attribution link);
 *   - the body is read raw here (the app mounts express.raw for this path ahead of the global JSON
 *     parser), so a malformed body cannot reach a parser whose error message would quote it.
 *
 * Load: 6 checks per minute per client address (shared Redis limiter, fails closed) and at most
 * WOLFRAM_READING_CHECK_UPSTREAM_MAX_PER_MIN (default 30, at most 120) upstream calls per minute for
 * the whole process. Each user's own Wolfram|Alpha plan limits still apply to their key.
 *
 * Dormant unless WOLFRAM_READING_CHECK_ENABLED=true (read per request; 404 otherwise).
 */
/* global AbortController, AbortSignal */
import express, { type Request, type RequestHandler, type Response } from 'express';

export type WolframFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface WolframReadingCheckDeps {
  fetchImpl?: WolframFetch;
  now?: () => number;
  /** `undefined` resolves the shared Redis limiter lazily; a missing limiter fails closed. */
  rateLimit?: RequestHandler;
  timeoutMs?: number;
}

export type Verdict = 'typical' | 'unusual' | 'outside_record' | 'unknown';
export interface ReferenceRange {
  typicalLowC: number | null;
  typicalHighC: number | null;
  recordLowC: number | null;
  recordHighC: number | null;
  averageC: number | null;
}

export const WOLFRAM_READING_CHECK_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 6, keyPrefix: 'ratelimit:wolfram-reading-check' };
export const WOLFRAM_QUERY_URL = 'https://api.wolframalpha.com/v2/query';
export const WOLFRAM_RESULTS_PAGE = 'https://www.wolframalpha.com/input';
export const MAX_BODY_BYTES = 2048;
const UPSTREAM_WINDOW_MS = 60_000;
const DEFAULT_UPSTREAM_MAX_PER_MIN = 30;
const MAX_UPSTREAM_MAX_PER_MIN = 120;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_POD_TEXT = 1500;
const MAX_UPSTREAM_BYTES = 512 * 1024;
// Wolfram|Alpha AppIDs are short upper-case alphanumeric strings with one dash ("XXXXXX-XXXXXXXXXX").
// Accept a little more than that shape, never anything that could change the upstream URL.
const APPID_RE = /^[A-Za-z0-9]{2,16}-[A-Za-z0-9]{4,32}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const enabled = () => process.env.WOLFRAM_READING_CHECK_ENABLED === 'true';
export function upstreamMaxPerMinute(): number {
  const raw = process.env.WOLFRAM_READING_CHECK_UPSTREAM_MAX_PER_MIN?.trim() ?? '';
  const value = /^[1-9][0-9]{0,4}$/.test(raw) ? Number(raw) : DEFAULT_UPSTREAM_MAX_PER_MIN;
  return Math.min(value, MAX_UPSTREAM_MAX_PER_MIN);
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...WOLFRAM_READING_CHECK_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many Wolfram checks, please try again in a minute.',
  });
}

export interface CheckInput {
  appId: string;
  latitude: number;
  longitude: number;
  month: number; // 1..12
  day: number; // 1..31
  temperatureC: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Validate the body. Only these five fields are read; anything else in the body is ignored. */
export function parseInput(body: unknown): { ok: true; value: CheckInput } | { ok: false; field: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.appId !== 'string' || !APPID_RE.test(b.appId)) return { ok: false, field: 'appId' };
  if (!finite(b.latitude) || Math.abs(b.latitude) > 90) return { ok: false, field: 'latitude' };
  if (!finite(b.longitude) || Math.abs(b.longitude) > 180) return { ok: false, field: 'longitude' };
  if (!finite(b.temperatureC) || b.temperatureC < -90 || b.temperatureC > 60) return { ok: false, field: 'temperatureC' };
  const m = typeof b.date === 'string' ? DATE_RE.exec(b.date) : null;
  if (!m) return { ok: false, field: 'date' };
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return { ok: false, field: 'date' };
  // The place is coarsened to 0.1 degree (about 11 km) here, whatever precision the caller sent.
  return { ok: true, value: { appId: b.appId, latitude: round1(b.latitude), longitude: round1(b.longitude), month, day, temperatureC: b.temperatureC } };
}

/** The one question this route ever asks Wolfram|Alpha: the climate of a place on a calendar day. */
export function buildQuery(input: Pick<CheckInput, 'latitude' | 'longitude' | 'month' | 'day'>): string {
  const lat = `${Math.abs(input.latitude).toFixed(1)}°${input.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(input.longitude).toFixed(1)}°${input.longitude >= 0 ? 'E' : 'W'}`;
  return `historical temperatures on ${MONTHS[input.month - 1]} ${input.day} at ${lat} ${lon}`;
}

export const resultsUrl = (query: string) => `${WOLFRAM_RESULTS_PAGE}?i=${encodeURIComponent(query)}`;

/** A temperature with its unit, as Wolfram|Alpha plaintext writes it ("-3 °C", "47 °F", "12.5°C"). */
const TEMP = String.raw`(-?\d+(?:\.\d+)?)\s*°\s*([CF])`;
const toC = (value: string, unit: string) => {
  const n = Number(value);
  return unit.toUpperCase() === 'F' ? round1(((n - 32) * 5) / 9) : n;
};

/**
 * Pull a reference range out of Wolfram|Alpha plaintext. Two shapes are understood:
 *   labelled:  "low: -12 °C ... | average low: -1 °C | average high: 8 °C | high: 22 °C ..."
 *   range:     "-3 °C to 14 °C (average: 6 °C)"   (the span of past years on that day)
 * Anything else yields null and the verdict is "unknown": a guess is never presented as a result.
 */
export function extractRange(input: string): ReferenceRange | null {
  const text = input.replace(/\u2212/g, '-'); // Wolfram|Alpha may write a typographic minus sign
  const pick = (label: string) => {
    const re = new RegExp(String.raw`(?:^|[|\n(]|\s)${label}\s*[:|]?\s*${TEMP}`, 'i');
    const m = re.exec(text);
    return m ? toC(m[1], m[2]) : null;
  };
  const typicalLowC = pick('average low');
  const typicalHighC = pick('average high');
  // "low"/"high" (records) must not re-match inside "average low"/"average high".
  const strip = text.replace(/average (low|high)/gi, 'avg_$1');
  const pickPlain = (label: string) => {
    const re = new RegExp(String.raw`(?:^|[|\n(]|\s)(?:record )?${label}\s*[:|]?\s*${TEMP}`, 'i');
    const m = re.exec(strip);
    return m ? toC(m[1], m[2]) : null;
  };
  let recordLowC = pickPlain('(?:low|min(?:imum)?)');
  let recordHighC = pickPlain('(?:high|max(?:imum)?)');
  let averageC = pick('(?:average|mean)');
  if (recordLowC === null && recordHighC === null) {
    const span = new RegExp(String.raw`${TEMP}\s*to\s*${TEMP}(?:\s*\(\s*(?:average|mean)\s*:?\s*${TEMP}\s*\))?`, 'i').exec(text);
    if (span) {
      recordLowC = toC(span[1], span[2]);
      recordHighC = toC(span[3], span[4]);
      if (span[5] !== undefined) averageC = toC(span[5], span[6]);
    }
  }
  const range = { typicalLowC, typicalHighC, recordLowC, recordHighC, averageC };
  return Object.values(range).some((v) => v !== null) ? range : null;
}

export function judge(temperatureC: number, r: ReferenceRange | null): Verdict {
  if (!r) return 'unknown';
  const { typicalLowC: tl, typicalHighC: th, recordLowC: rl, recordHighC: rh } = r;
  if (rl !== null && rh !== null && rl <= rh && (temperatureC < rl || temperatureC > rh)) return 'outside_record';
  if (tl !== null && th !== null && tl <= th) return temperatureC >= tl && temperatureC <= th ? 'typical' : 'unusual';
  if (rl !== null && rh !== null && rl <= rh) return 'typical';
  return 'unknown';
}

type Pod = { title: string; text: string };
/** Plaintext pods of a /v2/query JSON answer, or the reason there are none. */
export function readPods(raw: string): { kind: 'ok'; pods: Pod[] } | { kind: 'rejected' } | { kind: 'no_result' } | { kind: 'malformed' } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'malformed' };
  }
  const q = parsed?.queryresult;
  if (!q || typeof q !== 'object') return { kind: 'malformed' };
  if (q.error && typeof q.error === 'object') return { kind: 'rejected' };
  if (q.success !== true || !Array.isArray(q.pods)) return { kind: 'no_result' };
  const pods: Pod[] = [];
  for (const pod of q.pods) {
    const parts = Array.isArray(pod?.subpods) ? pod.subpods.map((s: any) => (typeof s?.plaintext === 'string' ? s.plaintext : '')) : [];
    const text = parts.filter(Boolean).join('\n');
    if (text) pods.push({ title: typeof pod?.title === 'string' ? pod.title : '', text });
  }
  return pods.length ? { kind: 'ok', pods } : { kind: 'no_result' };
}

/** The pod that answers the question: a temperature pod whose text yields a range. */
export function choosePod(pods: Pod[]): { pod: Pod; range: ReferenceRange } | null {
  const ranked = [...pods].sort((a, b) => score(b) - score(a));
  for (const pod of ranked) {
    const range = extractRange(pod.text);
    if (range) return { pod, range };
  }
  return null;
}
function score(p: Pod) {
  const t = `${p.title}`.toLowerCase();
  return (t.includes('historical') ? 4 : 0) + (t.includes('temperature') ? 2 : 0) + (t.includes('weather') ? 1 : 0) - (t.includes('input') ? 8 : 0);
}

export function createWolframReadingCheckRouter(deps: WolframReadingCheckDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: WolframFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init) as any);
  const budget = { windowStart: Number.NEGATIVE_INFINITY, used: 0 };

  let rateLimitPromise: Promise<RequestHandler> | null = null;
  const getRateLimit = () => {
    if (!rateLimitPromise) {
      rateLimitPromise = deps.rateLimit ? Promise.resolve(deps.rateLimit) : defaultRateLimit();
      rateLimitPromise.catch(() => { rateLimitPromise = null; });
    }
    return rateLimitPromise;
  };

  function takeBudget(at: number): number | null {
    if (at - budget.windowStart >= UPSTREAM_WINDOW_MS) { budget.windowStart = at; budget.used = 0; }
    if (budget.used >= upstreamMaxPerMinute()) return Math.max(1, Math.ceil((budget.windowStart + UPSTREAM_WINDOW_MS - at) / 1000));
    budget.used += 1;
    return null;
  }

  // The body arrives raw (express.raw mounted for this path by the app, or here when mounted alone).
  const rawBody = express.raw({ type: () => true, limit: MAX_BODY_BYTES });

  router.post('/reading-check', (req, res, next) => {
    if (!enabled()) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    getRateLimit().then(
      (limit) => limit(req, res, (err?: unknown) => {
        if (err) return next(err);
        rawBody(req, res, (parseErr?: unknown) => {
          // Never forward the parser's error: its message can quote the body, which holds the key.
          if (parseErr) {
            const tooBig = (parseErr as { type?: string })?.type === 'entity.too.large';
            return tooBig ? fail(res, 413, 'BODY_TOO_LARGE', 'The request body is too large.') : fail(res, 400, 'VALIDATION_ERROR', 'Expected a JSON body.');
          }
          void handle(req, res);
        });
      }),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Wolfram checks are unavailable, please try again later.'),
    );
  });

  async function handle(req: Request, res: Response) {
    if (!req.is('application/json')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the check as application/json.');
    let body: unknown;
    if (Buffer.isBuffer(req.body)) {
      try {
        body = JSON.parse(req.body.toString('utf8'));
      } catch {
        return fail(res, 400, 'VALIDATION_ERROR', 'Expected a JSON body.');
      }
    } else {
      body = req.body; // already parsed by an earlier parser (tests, or another mount order)
    }
    const parsed = parseInput(body);
    if ('field' in parsed) return fail(res, 400, 'VALIDATION_ERROR', `Invalid or missing field: ${parsed.field}.`);
    const input = parsed.value;

    const retryAfter = takeBudget(now());
    if (retryAfter !== null) {
      res.set('Retry-After', String(retryAfter));
      return fail(res, 503, 'UPSTREAM_BUDGET_EXHAUSTED', 'Wolfram checks are busy, please try again later.');
    }

    const query = buildQuery(input);
    const link = resultsUrl(query);
    const url = `${WOLFRAM_QUERY_URL}?${new URLSearchParams({
      appid: input.appId,
      input: query,
      output: 'json',
      format: 'plaintext',
      units: 'metric',
    }).toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let raw: string;
    let status: number;
    try {
      // No caller header is forwarded: the upstream request carries the user's AppID and nothing else of theirs.
      const upstream = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      status = upstream.status;
      raw = await upstream.text();
    } catch (error) {
      const e = error as { name?: string } | null;
      return e?.name === 'AbortError' || e?.name === 'TimeoutError'
        ? fail(res, 504, 'UPSTREAM_TIMEOUT', 'Wolfram|Alpha did not answer in time.')
        : fail(res, 502, 'UPSTREAM_ERROR', 'Wolfram|Alpha could not be reached.');
    } finally {
      clearTimeout(timer);
    }
    if (status === 401 || status === 403) return fail(res, 401, 'WOLFRAM_APPID_REJECTED', 'Wolfram|Alpha did not accept this AppID.');
    if (status === 429) return fail(res, 429, 'WOLFRAM_RATE_LIMITED', 'Your Wolfram|Alpha AppID has reached its limit for now.');
    if (status < 200 || status >= 300 || raw.length > MAX_UPSTREAM_BYTES) return fail(res, 502, 'UPSTREAM_ERROR', 'Wolfram|Alpha could not answer.');

    const pods = readPods(raw);
    if (pods.kind === 'rejected') return fail(res, 401, 'WOLFRAM_APPID_REJECTED', 'Wolfram|Alpha did not accept this AppID.');
    if (pods.kind === 'malformed') return fail(res, 502, 'UPSTREAM_ERROR', 'Wolfram|Alpha sent an answer this check cannot read.');
    const chosen = pods.kind === 'ok' ? choosePod(pods.pods) : null;
    const verdict = chosen ? judge(input.temperatureC, chosen.range) : 'unknown';
    return res.json({
      verdict,
      temperatureC: input.temperatureC,
      place: { latitude: input.latitude, longitude: input.longitude },
      reference: chosen?.range ?? null,
      pod: chosen ? { title: chosen.pod.title.slice(0, 200), text: chosen.pod.text.slice(0, MAX_POD_TEXT) } : null,
      query,
      resultsUrl: link,
      attribution: 'Wolfram|Alpha',
    });
  }

  return router;
}

export default createWolframReadingCheckRouter();
