/**
 * Leaderboard region/country enums — backend#693.
 *
 * Single source of truth for the `region` and `country` query-param values
 * accepted by GET /api/weather/leaderboard. Re-exported for the frontend via
 * shared types so Cindy's region-tab UI stays in lock-step with the server.
 */

export const LEADERBOARD_REGIONS = [
  'Global',
  'North America',
  'Europe',
  'Asia',
  'Oceania',
  'Africa',
  'South America',
  'Antarctica',
] as const;

export type LeaderboardRegion = (typeof LEADERBOARD_REGIONS)[number];

export function isLeaderboardRegion(value: unknown): value is LeaderboardRegion {
  return typeof value === 'string' && (LEADERBOARD_REGIONS as readonly string[]).includes(value);
}

/**
 * Continent bucket → set of ISO 3166-1 alpha-2 country codes.
 *
 * Curated for the launch set. Countries with weather submitters not yet
 * represented here fall through to the `country=XX` filter; expand this map
 * rather than the SQL if coverage gaps appear.
 */
export const REGION_COUNTRIES: Record<Exclude<LeaderboardRegion, 'Global'>, readonly string[]> = {
  'North America': ['US', 'CA', 'MX', 'CU', 'DO', 'GT', 'HT', 'HN', 'CR', 'PA', 'JM', 'TT', 'BS', 'NI', 'SV', 'BZ'],
  'Europe': [
    'GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'CH', 'AT', 'DK', 'SE', 'NO', 'FI',
    'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'HR', 'SI', 'RS', 'BA', 'MK', 'AL', 'ME',
    'UA', 'BY', 'LT', 'LV', 'EE', 'MD', 'LU', 'MT', 'CY',
  ],
  'Asia': [
    'CN', 'JP', 'KR', 'KP', 'IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MM', 'TH', 'VN', 'KH', 'LA',
    'MY', 'SG', 'ID', 'PH', 'TW', 'HK', 'MO', 'MN', 'KZ', 'UZ', 'TM', 'KG', 'TJ', 'AF',
    'IR', 'IQ', 'SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'YE', 'JO', 'LB', 'SY', 'IL', 'PS', 'TR',
  ],
  'Oceania': ['AU', 'NZ', 'PG', 'FJ', 'SB', 'VU', 'NC', 'PF', 'WS', 'TO', 'KI', 'FM', 'MH', 'PW', 'NR', 'TV'],
  'Africa': [
    'ZA', 'EG', 'NG', 'KE', 'ET', 'GH', 'MA', 'DZ', 'TN', 'LY', 'SD', 'SS', 'UG', 'TZ', 'RW',
    'BI', 'CM', 'CI', 'SN', 'ML', 'BF', 'NE', 'TD', 'CF', 'CG', 'CD', 'GA', 'GQ', 'AO', 'ZM',
    'ZW', 'BW', 'NA', 'MZ', 'MW', 'MG', 'MU', 'SC', 'SO', 'DJ', 'ER', 'LR', 'SL', 'GN', 'GM',
    'GW', 'CV', 'ST', 'LS', 'SZ', 'KM',
  ],
  'South America': ['BR', 'AR', 'CL', 'CO', 'PE', 'VE', 'EC', 'BO', 'PY', 'UY', 'GY', 'SR', 'GF'],
  'Antarctica': ['AQ'],
};

export function countryCodesForRegion(region: LeaderboardRegion): readonly string[] | null {
  if (region === 'Global') return null;
  return REGION_COUNTRIES[region];
}

export interface ParsedNear {
  lat: number;
  lng: number;
  radiusKm: number;
}

export const NEAR_DEFAULT_RADIUS_KM = 500;
export const NEAR_MAX_RADIUS_KM = 5000;
// backend#1222: with no floor, `near` + a tiny radius_km answered "who
// submits from within 100 m of this point?". Smaller requests are clamped up.
export const NEAR_MIN_RADIUS_KM = 25;

/**
 * Parses `?near=lat,lng` (comma-separated decimal degrees) plus optional
 * `?radius_km=N`. Returns null for missing/invalid input so the caller can
 * short-circuit to the non-geofiltered query. Caller is responsible for
 * emitting a 400 if strict validation is required.
 */
export function parseNear(nearRaw: unknown, radiusRaw: unknown): ParsedNear | null {
  if (typeof nearRaw !== 'string' || nearRaw.length === 0) return null;
  const [latStr, lngStr] = nearRaw.split(',', 2);
  if (!latStr || !lngStr) return null;
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  let radiusKm = NEAR_DEFAULT_RADIUS_KM;
  if (radiusRaw !== undefined && radiusRaw !== null && radiusRaw !== '') {
    const parsed = Number(radiusRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    radiusKm = Math.min(Math.max(parsed, NEAR_MIN_RADIUS_KM), NEAR_MAX_RADIUS_KM);
  }

  return { lat, lng, radiusKm };
}
