/**
 * Friend challenges (backend#249; owner demo queue 2026-11-01, item 8): "Two friends start a 7-day
 * collection challenge on their phones and watch each other's counts."
 *
 * Contract: the phone screen that already exists (mobile lib/features/challenges, gated off in
 * mobile#260): create a challenge, join by invite code, read the challenges you are in, refresh counts.
 *
 * Rules:
 *   - Identity is the wallet. Every write needs a wallet login token for the acting wallet; nothing else
 *     about a person is stored (owner ruling 2026-11-01: no personal data). Participants are shown as
 *     "Collector ABCD" plus their address.
 *   - Points only. Nothing is paid, minted or promised (the 2026-04 router wrote a "rewardAmountWrf" with
 *     no payout behind it; it is replaced).
 *   - A participant's count is NOT reported by the phone. It is the number of readings from stations the
 *     wallet owns (weather_stations.owner_address, mobile_station_registrations.owner_address) that landed
 *     on chain (core4 GET /transactions/contributions/{station}/observations) with an observation time
 *     inside the challenge window. Synthetic readings do not count. A wallet with no station counts 0 and
 *     the response says how many stations it has.
 *   - A challenge is pending until it has two participants (head-to-head) or two teams (team), live until
 *     its end time or until someone reaches the target, then completed and frozen.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Get = (path: string, query?: Record<string, unknown>) => Promise<Core4Response>;

export const friendChallengesEnabled = () => process.env.FRIEND_CHALLENGES_ENABLED === 'true';

export const FORMATS = { headToHead: 'head_to_head', team: 'team' } as const;
export type ApiFormat = keyof typeof FORMATS;
export const TEAM_NAMES = ['North Front', 'Rain Riders'] as const;
export const MAX_ACTIVE_CREATED = 5;
export const MAX_TEAM_PARTICIPANTS = 20;
export const MIN_DURATION_HOURS = 1;
export const MAX_DURATION_HOURS = 30 * 24;
export const MAX_TARGET = 100_000;
export const METRIC_LABEL = 'readings on chain';
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class ChallengeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return ADDRESS_RE.test(lower) ? lower : null;
}

export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function generateInviteCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export const displayName = (address: string) => `Collector ${address.slice(-4).toUpperCase()}`;

export interface CreateInput { title: string; description: string; format: ApiFormat; targetScore: number; durationHours: number }

export function parseCreateInput(body: any): CreateInput {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (title.length < 1 || title.length > 60) throw new ChallengeError(400, 'INVALID_TITLE', 'title must be 1-60 characters');
  if (description.length > 200) throw new ChallengeError(400, 'INVALID_DESCRIPTION', 'description must be at most 200 characters');
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(title + description)) throw new ChallengeError(400, 'INVALID_TEXT', 'title and description cannot contain control characters');
  const format = body?.format;
  if (format !== 'headToHead' && format !== 'team') throw new ChallengeError(400, 'INVALID_FORMAT', 'format must be headToHead or team');
  const targetScore = body?.targetScore;
  if (!Number.isInteger(targetScore) || targetScore < 1 || targetScore > MAX_TARGET) {
    throw new ChallengeError(400, 'INVALID_TARGET', `targetScore must be a whole number from 1 to ${MAX_TARGET}`);
  }
  const durationHours = body?.durationHours;
  if (!Number.isInteger(durationHours) || durationHours < MIN_DURATION_HOURS || durationHours > MAX_DURATION_HOURS) {
    throw new ChallengeError(400, 'INVALID_DURATION', `durationHours must be a whole number from ${MIN_DURATION_HOURS} to ${MAX_DURATION_HOURS}`);
  }
  return { title, description, format, targetScore, durationHours };
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null);

/** The phone's ChallengeModel shape (mobile challenge_model.dart), built from the stored rows. */
export function challengeView(c: any, participants: any[], nowMs: number) {
  const format: ApiFormat = c.format === FORMATS.team ? 'team' : 'headToHead';
  const ended = c.completed_at !== null && c.completed_at !== undefined ? true : new Date(c.ends_at).getTime() <= nowMs;
  const teams = new Set(participants.map((p) => p.team_name).filter((t) => typeof t === 'string' && t.length > 0));
  const ready = format === 'headToHead' ? participants.length >= 2 : teams.size >= 2;
  const status = ended ? 'completed' : ready ? 'live' : 'pending';
  const lastScored = participants.map((p) => (p.score_updated_at ? new Date(p.score_updated_at).getTime() : 0));
  const lastUpdated = Math.max(new Date(c.updated_at).getTime(), ...lastScored);
  return {
    id: c.id,
    title: c.title,
    description: c.description ?? '',
    format,
    status,
    inviteCode: c.invite_code,
    targetScore: Number(c.target_score),
    startsAt: iso(c.starts_at),
    endsAt: iso(c.ends_at),
    completedAt: iso(c.completed_at),
    lastUpdatedAt: new Date(lastUpdated).toISOString(),
    metricLabel: METRIC_LABEL,
    scoring: {
      source: 'chain',
      note: 'Counts are readings from stations each wallet owns that landed on chain during the challenge. Points only: nothing is paid.',
      countedAt: participants.some((p) => p.score_updated_at) ? new Date(Math.max(...lastScored)).toISOString() : null,
    },
    participants: participants
      .slice()
      .sort((a, b) => Number(b.score) - Number(a.score) || new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime())
      .map((p) => ({
        id: p.address,
        name: displayName(p.address),
        score: Number(p.score),
        teamName: p.team_name ?? '',
        subtitle: p.address === c.creator_address ? 'Challenge host' : 'Joined by invite code',
        stations: p.stations === null || p.stations === undefined ? null : Number(p.stations),
      })),
  };
}

const CHALLENGE_COLUMNS = 'id, title, description, format, target_score, invite_code, creator_address, starts_at, ends_at, completed_at, created_at, updated_at';
const STATIONS_OF = (addressExpr: string) => `(SELECT station_id FROM weather_stations WHERE lower(owner_address) = ${addressExpr} AND station_id IS NOT NULL
  UNION SELECT station_id FROM mobile_station_registrations WHERE lower(owner_address) = ${addressExpr})`;

async function viewsFor(query: Query, challengeRows: any[], nowMs: number) {
  if (challengeRows.length === 0) return [];
  const ids = challengeRows.map((c) => c.id);
  const parts = (await query(`SELECT p.challenge_id, p.address, p.team_name, p.joined_at, p.score, p.score_updated_at, p.stations
    FROM friend_challenge_participants p WHERE p.challenge_id = ANY($1::text[])`, [ids])).rows;
  return challengeRows.map((c) => challengeView(c, parts.filter((p) => p.challenge_id === c.id), nowMs));
}

export async function listForWallet(query: Query, address: string, nowMs: number) {
  const rows = (await query(`SELECT ${CHALLENGE_COLUMNS} FROM friend_challenges c
    WHERE c.id IN (SELECT challenge_id FROM friend_challenge_participants WHERE address = $1)
    ORDER BY c.created_at DESC LIMIT 50`, [address])).rows;
  return viewsFor(query, rows, nowMs);
}

export async function readByCode(query: Query, code: string, nowMs: number) {
  const rows = (await query(`SELECT ${CHALLENGE_COLUMNS} FROM friend_challenges WHERE invite_code = $1`, [code])).rows;
  return (await viewsFor(query, rows, nowMs))[0] ?? null;
}

async function stationCount(query: Query, address: string): Promise<number> {
  const row = (await query(`SELECT count(*)::int AS n FROM ${STATIONS_OF('$1')} s`, [address])).rows[0];
  return Number(row?.n ?? 0);
}

export async function createChallenge(query: Query, address: string, input: CreateInput, nowMs: number, newCode = generateInviteCode) {
  const active = (await query(`SELECT count(*)::int AS n FROM friend_challenges
    WHERE creator_address = $1 AND completed_at IS NULL AND ends_at > to_timestamp($2)`, [address, nowMs / 1000])).rows[0];
  if (Number(active?.n ?? 0) >= MAX_ACTIVE_CREATED) {
    throw new ChallengeError(409, 'TOO_MANY_ACTIVE', `A wallet can run at most ${MAX_ACTIVE_CREATED} challenges at a time`);
  }
  const id = randomUUID();
  const stations = await stationCount(query, address);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode();
    const inserted = (await query(`INSERT INTO friend_challenges (id, title, description, format, target_score, invite_code, creator_address, starts_at, ends_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($8) + make_interval(hours => $9::int))
      ON CONFLICT (invite_code) DO NOTHING RETURNING id`,
    [id, input.title, input.description, FORMATS[input.format], input.targetScore, code, address, nowMs / 1000, input.durationHours])).rows;
    if (inserted.length === 0) continue;
    await query('INSERT INTO friend_challenge_participants (challenge_id, address, team_name, stations) VALUES ($1, $2, $3, $4)',
      [id, address, input.format === 'team' ? TEAM_NAMES[0] : null, stations]);
    return listForWallet(query, address, nowMs);
  }
  throw new ChallengeError(503, 'CODE_UNAVAILABLE', 'Could not allocate an invite code, please try again');
}

/** Team assignment: the team with fewer members (ties: the first), as the phone's local version did. */
export function assignTeam(existing: Array<string | null>): string {
  const counts = TEAM_NAMES.map((t) => existing.filter((e) => e === t).length);
  return counts[1] < counts[0] ? TEAM_NAMES[1] : counts[0] < counts[1] ? TEAM_NAMES[0] : TEAM_NAMES[existing.length === 0 ? 0 : 1];
}

export async function joinByCode(query: Query, address: string, code: string, nowMs: number) {
  const c = (await query(`SELECT ${CHALLENGE_COLUMNS} FROM friend_challenges WHERE invite_code = $1`, [code])).rows[0];
  if (!c) throw new ChallengeError(404, 'NO_SUCH_CODE', 'No challenge matched that invite code');
  if (c.completed_at || new Date(c.ends_at).getTime() <= nowMs) throw new ChallengeError(409, 'CHALLENGE_ENDED', 'This challenge has ended');
  const members = (await query('SELECT address, team_name FROM friend_challenge_participants WHERE challenge_id = $1', [c.id])).rows;
  if (members.some((m) => m.address === address)) throw new ChallengeError(409, 'ALREADY_JOINED', 'You already joined this challenge');
  if (c.format === FORMATS.headToHead && members.length >= 2) throw new ChallengeError(409, 'CHALLENGE_FULL', 'This head-to-head challenge is already full');
  if (c.format === FORMATS.team && members.length >= MAX_TEAM_PARTICIPANTS) throw new ChallengeError(409, 'CHALLENGE_FULL', 'This team challenge is full');
  const team = c.format === FORMATS.team ? assignTeam(members.map((m) => m.team_name)) : null;
  // The cap is re-checked inside the insert, so two simultaneous joins cannot overfill a head-to-head.
  const cap = c.format === FORMATS.headToHead ? 2 : MAX_TEAM_PARTICIPANTS;
  const inserted = (await query(`INSERT INTO friend_challenge_participants (challenge_id, address, team_name, stations)
    SELECT $1, $2, $3, $4 WHERE (SELECT count(*) FROM friend_challenge_participants WHERE challenge_id = $1) < $5
    ON CONFLICT DO NOTHING RETURNING address`, [c.id, address, team, await stationCount(query, address), cap])).rows;
  if (inserted.length === 0) throw new ChallengeError(409, 'CHALLENGE_FULL', 'This challenge filled up, try another code');
  await query('UPDATE friend_challenges SET updated_at = now() WHERE id = $1', [c.id]);
  return listForWallet(query, address, nowMs);
}

// ---------------------------------------------------------------------------------------------------
// Counting job
// ---------------------------------------------------------------------------------------------------

/** core4 get_station_observations walks at most 64 heights per call. */
const SCAN_WINDOW = 64;
export const PAGES_PER_STATION = 4;
export const STATIONS_PER_PASS = 50;
const CADENCE_GUESS_S = 77;
/** A reading observed just before the end can take a few blocks to land: freeze 15 minutes after the end. */
export const FREEZE_GRACE_MINUTES = 15;

const safeInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
function unwrap(payload: any): Record<string, any> | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/** Walk one station's chain readings forward from its cursor; store each reading once. */
export async function scanStation(query: Query, get: Core4Get, stationId: string, startAfter: number, tip: number): Promise<{ readings: number; complete: boolean }> {
  const cursor = (await query('SELECT next_after, next_offset FROM friend_challenge_station_cursor WHERE station_id = $1', [stationId])).rows[0];
  let after = cursor ? Number(cursor.next_after) : Math.max(0, startAfter);
  let offset = cursor ? Number(cursor.next_offset) : 0;
  let stored = 0;
  let complete = false;
  for (let page = 0; page < PAGES_PER_STATION && after < tip; page += 1) {
    const reply = await get(`/transactions/contributions/${encodeURIComponent(stationId)}/observations`, { after, offset, limit: 100 });
    const data = reply.ok ? unwrap(reply.payload) : null;
    if (!data || !Array.isArray(data.items)) throw new Error('chain read failed');
    for (const item of data.items) {
      const height = safeInt(item?.height);
      const observedAt = safeInt(item?.observed_at);
      if (height === null || observedAt === null || typeof item.commit_id !== 'string' || item.commit_id.length > 128) continue;
      if (item.provenance_class === 'synthetic') continue;
      await query(`INSERT INTO friend_challenge_readings (station_id, commit_id, height, observed_at) VALUES ($1, $2, $3, to_timestamp($4))
        ON CONFLICT DO NOTHING`, [stationId, item.commit_id, height, observedAt]);
      stored += 1;
    }
    const nextAfter = safeInt(data.next_after);
    const nextOffset = safeInt(data.next_offset);
    if (nextAfter === null || nextOffset === null || nextAfter < after || (nextAfter === after && nextOffset <= offset)) break;
    after = nextAfter;
    offset = nextOffset;
    if (data.has_more === false) { complete = true; break; }
  }
  if (after >= tip) complete = true;
  await query(`INSERT INTO friend_challenge_station_cursor (station_id, next_after, next_offset, updated_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (station_id) DO UPDATE SET next_after = EXCLUDED.next_after, next_offset = EXCLUDED.next_offset, updated_at = now()`, [stationId, after, offset]);
  return { readings: stored, complete };
}

export interface CountPassDeps { query: Query; get: Core4Get; nowMs: number }

/**
 * One counting pass: scan the stations of every participant in a challenge that has started and is not
 * frozen, recount each participant, then freeze challenges that ended or reached their target.
 */
export async function countPass({ query, get, nowMs }: CountPassDeps) {
  const nowSec = nowMs / 1000;
  const stations = (await query(`SELECT s.station_id, min(c.starts_at) AS since FROM friend_challenges c
      JOIN friend_challenge_participants p ON p.challenge_id = c.id
      JOIN LATERAL ${STATIONS_OF('p.address')} s ON true
    WHERE c.completed_at IS NULL AND c.starts_at <= to_timestamp($1)
    GROUP BY s.station_id ORDER BY s.station_id LIMIT ${STATIONS_PER_PASS}`, [nowSec])).rows;
  let scanned = 0;
  let failed = 0;
  if (stations.length > 0) {
    const tipReply = await get('/blockchain');
    const tip = safeInt(unwrap(tipReply.ok ? tipReply.payload : null)?.height);
    if (tip === null) return { stations: stations.length, scanned: 0, failed: stations.length, recounted: 0, completed: 0 };
    for (const s of stations) {
      // First scan of a station: start one window before the height the earliest challenge began at.
      const since = new Date(s.since).getTime() / 1000;
      const startAfter = tip - Math.ceil(Math.max(0, nowSec - since) / CADENCE_GUESS_S) - SCAN_WINDOW;
      try { await scanStation(query, get, s.station_id, startAfter, tip); scanned += 1; } catch { failed += 1; }
    }
  }
  const recounted = (await query(`UPDATE friend_challenge_participants p SET
      score = (SELECT count(*) FROM friend_challenge_readings r
        WHERE r.station_id IN ${STATIONS_OF('p.address')}
          AND r.observed_at >= c.starts_at AND r.observed_at < c.ends_at),
      stations = (SELECT count(*) FROM ${STATIONS_OF('p.address')} s),
      score_updated_at = to_timestamp($1)
    FROM friend_challenges c
    WHERE c.id = p.challenge_id AND c.completed_at IS NULL AND c.starts_at <= to_timestamp($1)
    RETURNING p.challenge_id`, [nowSec])).rows.length;
  const completed = (await query(`UPDATE friend_challenges c SET completed_at = LEAST(c.ends_at, to_timestamp($1)), updated_at = now()
    WHERE c.completed_at IS NULL AND (c.ends_at <= to_timestamp($1) - make_interval(mins => ${FREEZE_GRACE_MINUTES})
      OR EXISTS (SELECT 1 FROM friend_challenge_participants p WHERE p.challenge_id = c.id AND p.score >= c.target_score))
    RETURNING c.id`, [nowSec])).rows.length;
  return { stations: stations.length, scanned, failed, recounted, completed };
}
