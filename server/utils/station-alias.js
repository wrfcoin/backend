/**
 * Public station aliases (owner ruling 2026-09-27, Q5 = a).
 *
 * Station ids can carry personal names (e.g. `PWS-DULUTH-<FIRSTNAME>-...`). The
 * anonymous API and public routes therefore identify a station by a short,
 * deterministic, opaque alias; the real id stays internal.
 *
 *   alias = "st_" + first 12 hex chars of sha256("wrfcoin-station-alias-v1:" + stationId)
 *
 * The alias is COSMETIC, NOT SECRET: every station id is public on chain (in
 * its StationRegistration transaction and the station registry), so anyone can
 * compute the alias of a known id. It only keeps names out of public URLs,
 * page titles and JSON. It is not an access control.
 *
 * The same derivation exists in SQL (STATION_ALIAS_SQL) so an alias resolves to
 * its row without a stored column; JS/SQL equality is proven against a real
 * PostgreSQL in __tests__/station-alias.test.ts (runs when BACKFILL_TEST_PG_URL
 * is set, as in the build runner CI).
 */

const { createHash } = require('node:crypto');

const STATION_ALIAS_DOMAIN = 'wrfcoin-station-alias-v1:';
const STATION_ALIAS_RE = /^st_[0-9a-f]{12}$/;

function stationAlias(stationId) {
  const digest = createHash('sha256').update(STATION_ALIAS_DOMAIN + String(stationId), 'utf8').digest('hex');
  return `st_${digest.slice(0, 12)}`;
}

function isStationAlias(value) {
  return typeof value === 'string' && STATION_ALIAS_RE.test(value);
}

/** SQL expression computing the alias of weather_stations.station_id. */
const STATION_ALIAS_SQL =
  "'st_' || substr(encode(sha256(convert_to('wrfcoin-station-alias-v1:' || station_id, 'UTF8')), 'hex'), 1, 12)";

/**
 * Resolve an alias to its station id via `query(sql, params) -> rows`.
 * Returns { status: 'found', stationId } | { status: 'not-found' } | { status: 'ambiguous' }.
 * Two rows sharing an alias (a 48-bit collision) resolve to NOTHING: fail
 * closed rather than serve one station's data under another's alias.
 */
async function resolveStationAlias(query, alias) {
  if (!isStationAlias(alias)) return { status: 'not-found' };
  const rows = await query(
    `SELECT station_id FROM weather_stations WHERE ${STATION_ALIAS_SQL} = $1 LIMIT 2`,
    [alias]
  );
  if (!rows || rows.length === 0) return { status: 'not-found' };
  if (rows.length > 1) return { status: 'ambiguous' };
  const stationId = rows[0].station_id;
  // Belt and braces: the row must hash back to the alias in JS too.
  if (typeof stationId !== 'string' || stationAlias(stationId) !== alias) return { status: 'not-found' };
  return { status: 'found', stationId };
}

/** Distinct ids that collide on an alias (tests and audits). */
function findAliasCollisions(stationIds) {
  const byAlias = new Map();
  for (const id of stationIds) {
    const alias = stationAlias(id);
    if (!byAlias.has(alias)) byAlias.set(alias, new Set());
    byAlias.get(alias).add(id);
  }
  return [...byAlias.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([alias, ids]) => ({ alias, stationIds: [...ids].sort() }));
}

/** Ids shorter than this are matched EXACTLY, not as substrings (see scrubRawId). */
const SCRUB_SUBSTRING_MIN_LENGTH = 6;

/**
 * The last-line guard on every anonymous station response (#1258).
 *
 * Removes object keys and nulls string values that contain `rawId`
 * (case-insensitive), recursively; the `alias` key is never touched (it is a
 * hash of the id, not the id, and its hex digits may coincidentally contain a
 * short id). For ids shorter than SCRUB_SUBSTRING_MIN_LENGTH characters (core4
 * allows e.g. "a", "st", "1") substring matching would strip unrelated keys
 * such as `status`/`latitude` and null the alias, so only EXACT (case-
 * insensitive) matches are removed (#1258 review P3). Display names have their
 * own contains-check (publicStationName), and every other anonymous value is an
 * allowlisted enum, ISO timestamp, hex hash or number.
 */
function scrubRawId(value, rawId) {
  const needle = String(rawId || '').toLowerCase();
  if (!needle) return value;
  const substring = needle.length >= SCRUB_SUBSTRING_MIN_LENGTH;
  const hits = (text) => {
    const t = text.toLowerCase();
    return substring ? t.includes(needle) : t === needle;
  };
  const walk = (v) => {
    if (typeof v === 'string') return hits(v) ? null : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out = {};
      for (const [k, inner] of Object.entries(v)) {
        if (k === 'alias') {
          out[k] = inner;
          continue;
        }
        if (hits(k)) continue;
        out[k] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

module.exports = {
  SCRUB_SUBSTRING_MIN_LENGTH,
  scrubRawId,
  STATION_ALIAS_DOMAIN,
  STATION_ALIAS_RE,
  STATION_ALIAS_SQL,
  stationAlias,
  isStationAlias,
  resolveStationAlias,
  findAliasCollisions,
};
