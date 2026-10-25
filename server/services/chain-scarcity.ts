/**
 * The data-scarcity rule the chain PAYS (core4#28, ADR 2026-10-23-3563, owner answer A1).
 *
 * core4 `GET /network/scarcity` reports the bonus from the same function and the same station
 * counts the payout reads (about 2 degree cells, fewer than 3 active registered stations pays
 * x1.5). This reader fetches that, validates it and caches it briefly. It never derives a rule
 * of its own: a node that cannot answer is `unavailable`, not a guessed zone list.
 */
type Row = Record<string, any>;
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; payload: any }>;

export type ScarcityRule = {
  gridKm: number;
  cellSizeDegrees: number;
  minStationDensity: number;
  desertBonusMultiplier: number;
  baselineMultiplier: number;
  activationHeight: number;
  active: boolean;
};
export type ScarcityCell = {
  latIdx: number;
  lonIdx: number;
  centerLatitude: number;
  centerLongitude: number;
  stationCount: number;
  multiplier: number;
};
export type ScarcityView = { rule: ScarcityRule; cells: ScarcityCell[]; observedAtHeight: number };
export type ScarcityResult = { kind: 'ok'; view: ScarcityView } | { kind: 'unavailable' };

/** Hyper-local accuracy bonus composes with the desert bonus up to this combined cap (hyper_local.rs). */
const MAX_PERCENT = 200;
const MAX_CELLS = 20_000;
const CACHE_TTL_MS = 30_000;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Strictly validate a core4 ScarcityResponse; null on any malformed part. */
export function parseScarcityPayload(payload: unknown): ScarcityView | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload as Row;
  const r = body.rule as Row | undefined;
  if (!r || typeof r !== 'object') return null;
  if (
    !isInt(r.grid_km, 1, 255) || !isNum(r.cell_size_degrees, 0.01, 90) ||
    !isInt(r.min_station_density, 0, 1_000_000) || !isInt(r.desert_bonus_percent, 100, MAX_PERCENT) ||
    !isInt(r.baseline_percent, 100, 100) || !isInt(r.activation_height, 0, Number.MAX_SAFE_INTEGER) ||
    typeof r.active !== 'boolean' || !isInt(body.observed_at_height, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(body.cells) || body.cells.length > MAX_CELLS
  ) return null;
  const cells: ScarcityCell[] = [];
  for (const c of body.cells as unknown[]) {
    const cell = c as Row;
    if (
      !cell || typeof cell !== 'object' ||
      !isInt(cell.lat_idx, -100_000, 100_000) || !isInt(cell.lon_idx, -100_000, 100_000) ||
      !isNum(cell.center_latitude, -90, 90) || !isNum(cell.center_longitude, -180, 180) ||
      !isInt(cell.station_count, 0, 4_294_967_295) || !isInt(cell.multiplier_percent, 100, MAX_PERCENT)
    ) return null;
    cells.push({
      latIdx: cell.lat_idx, lonIdx: cell.lon_idx,
      centerLatitude: cell.center_latitude, centerLongitude: cell.center_longitude,
      stationCount: cell.station_count, multiplier: cell.multiplier_percent / 100,
    });
  }
  return {
    rule: {
      gridKm: r.grid_km, cellSizeDegrees: r.cell_size_degrees, minStationDensity: r.min_station_density,
      desertBonusMultiplier: r.desert_bonus_percent / 100, baselineMultiplier: r.baseline_percent / 100,
      activationHeight: r.activation_height, active: r.active,
    },
    cells,
    observedAtHeight: body.observed_at_height,
  };
}

export function createScarcityReader(deps: {
  fetchCore4Json: Core4Fetch;
  readerToken: () => string | undefined;
  now?: () => number;
}): () => Promise<ScarcityResult> {
  const now = deps.now ?? Date.now;
  let cached: { expiresAt: number; value: Promise<ScarcityResult> } | null = null;

  async function load(token: string): Promise<ScarcityResult> {
    try {
      const res = await deps.fetchCore4Json('/network/scarcity', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      const view = res.ok ? parseScarcityPayload(res.payload) : null;
      return view ? { kind: 'ok', view } : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return async () => {
    const token = deps.readerToken();
    if (!token) return { kind: 'unavailable' };
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = load(token);
    cached = { expiresAt: now() + CACHE_TTL_MS, value };
    const result = await value;
    // Do not pin a failure for the whole TTL.
    if (result.kind === 'unavailable' && cached?.value === value) cached = null;
    return result;
  };
}

let defaultReader: (() => Promise<ScarcityResult>) | null = null;
export async function getDefaultScarcityReader(): Promise<() => Promise<ScarcityResult>> {
  if (!defaultReader) {
    const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
    defaultReader = createScarcityReader({
      fetchCore4Json: fetchCore4Json as unknown as Core4Fetch,
      readerToken: () => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined,
    });
  }
  return defaultReader;
}

/** Test seam: drop the shared reader and its cache. */
export function resetDefaultScarcityReader(): void {
  defaultReader = null;
}
