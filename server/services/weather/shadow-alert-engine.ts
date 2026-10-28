/** Offline/internal shadow evaluator. No transport imports or sender dependency. */
export type Hazard = 'rain' | 'heat' | 'wind';
export interface VerifiedReading {
  station: string; cell: string; region: string; at: number;
  verification: 'verified' | 'pending'; qualityTier: 'good' | 'degraded' | 'outlier';
  referenceAvailable: boolean;
  rainRateMmH?: number; rainHourMm?: number; heatIndexC?: number; gustMs?: number;
}
export interface OfficialAlert {
  id: string; url: string; hazard: Hazard; cells: string[]; start: number; end: number;
}
export interface ForecastSignal { hazard: Hazard; cell: string; start: number; end: number; verified: boolean }
export interface RegionConfig {
  rainRateMmH: number; rainHourMm: number; heatIndexC: number; gustMs: number;
  stations: number; cooldownMs: number; freshnessMs: number; releaseRatio: number;
}
// Research defaults only; region enrolment must be explicit. See docs/alerts/thresholds.md.
export const RESEARCH_DEFAULTS: RegionConfig = {
  rainRateMmH: 30, rainHourMm: 30, heatIndexC: 40.56, gustMs: 25.93,
  stations: 2, cooldownMs: 3_600_000, freshnessMs: 600_000, releaseRatio: 0.8,
};
export interface ShadowEvent {
  id: string; hazard: Hazard; cell: string; region: string; at: number; expires: number;
  status: 'advisory' | 'suppressed_by_official'; official: OfficialAlert[];
  stations: string[]; confidence: 'corroborated'; shadow: true;
}
export interface ShadowState {
  events: ShadowEvent[];
  episodes: Record<string, { latched: boolean; lastEmitted: number; lastEvaluated: number }>;
}
export function emptyShadowState(): ShadowState { return { events: [], episodes: {} }; }
export class ShadowAlertEngine {
  constructor(readonly configs: Record<string, RegionConfig>, readonly state: ShadowState,
    readonly enabled = process.env.ALERT_ENGINE_SHADOW === '1') {
    for (const c of Object.values(configs)) {
      if (!Object.values(c).every(Number.isFinite) || c.stations < 2 || !Number.isInteger(c.stations)
        || c.cooldownMs <= 0 || c.freshnessMs <= 0 || c.releaseRatio <= 0 || c.releaseRatio >= 1
        || c.rainRateMmH <= 0 || c.rainHourMm <= 0 || c.heatIndexC <= 0 || c.gustMs <= 0) {
        throw new Error('Invalid shadow threshold configuration');
      }
    }
  }
  evaluate(now: number, readings: VerifiedReading[], official: OfficialAlert[], forecasts: ForecastSignal[] = []): ShadowEvent[] {
    if (!this.enabled) return [];
    if (!Number.isFinite(now)) throw new Error('Invalid evaluation time');
    // Unknown/invalid official coverage is not interpreted as an all-clear.
    for (const a of official) {
      if (!a.id || !/^https:\/\//.test(a.url) || !['rain', 'heat', 'wind'].includes(a.hazard)
        || !Array.isArray(a.cells) || !a.cells.length || !a.cells.every(validCell)
        || !Number.isFinite(a.start) || !Number.isFinite(a.end) || a.end <= a.start) {
        throw new Error('Invalid official alert coverage');
      }
    }
    const emitted: ShadowEvent[] = [];
    for (const [region, c] of Object.entries(this.configs)) {
      const eligible = readings.filter(r => r.region === region && validCell(r.cell)
        && /^[a-z0-9_-]{1,64}$/.test(r.station) && r.verification === 'verified'
        && r.qualityTier === 'good' && r.referenceAvailable === true
        && Number.isFinite(r.at) && r.at <= now && now - r.at <= c.freshnessMs);
      const cells = new Set(eligible.map(r => r.cell));
      for (const cell of cells) {
        // Latest reading per station, not repeated packets; ties fail closed by first occurrence.
        const latest = new Map<string, VerifiedReading>();
        for (const r of eligible.filter(r => r.cell === cell)) {
          if (!latest.has(r.station) || latest.get(r.station)!.at < r.at) latest.set(r.station, r);
        }
        for (const hazard of ['rain', 'heat', 'wind'] as Hazard[]) {
          const key = JSON.stringify([region, cell, hazard]);
          const previous = this.state.episodes[key];
          if (previous && now <= previous.lastEvaluated) continue;
          const episode = previous || { latched: false, lastEmitted: -Number.MAX_VALUE, lastEvaluated: now };
          episode.lastEvaluated = now;
          this.state.episodes[key] = episode;
          const values = [...latest.values()].map(r => ({ r, ratio: ratio(r, hazard, c) })).filter(x => x.ratio !== null);
          const triggering = values.filter(x => x.ratio! >= 1);
          const forecast = forecasts.some(f => f.verified === true && f.cell === cell && f.hazard === hazard
            && Number.isFinite(f.start) && Number.isFinite(f.end) && f.start <= now && now < f.end);
          // Reset only with corroborated clear observations, never missing data.
          if (values.length >= c.stations && values.every(x => x.ratio! < c.releaseRatio)) episode.latched = false;
          const corroborated = triggering.length >= c.stations || (triggering.length >= 1 && forecast);
          if (!corroborated) continue;
          const overlapping = official.filter(a => a.hazard === hazard && a.cells.includes(cell)
            && a.start < now + c.freshnessMs && a.end > now);
          // Official precedence also applies to an earlier advisory during a latched episode.
          for (const old of this.state.events) {
            if (old.cell === cell && old.hazard === hazard && old.expires > now && overlapping.length) {
              old.status = 'suppressed_by_official'; old.official = structuredClone(overlapping);
            }
          }
          if (episode.latched || now - episode.lastEmitted < c.cooldownMs) continue;
          const event: ShadowEvent = {
            id: `${region}:${cell}:${hazard}:${now}`, region, cell, hazard, at: now,
            expires: now + c.freshnessMs, status: overlapping.length ? 'suppressed_by_official' : 'advisory',
            official: structuredClone(overlapping), stations: triggering.map(x => x.r.station).sort(),
            confidence: 'corroborated', shadow: true,
          };
          this.state.events.push(event); emitted.push(structuredClone(event));
          episode.latched = true; episode.lastEmitted = now;
        }
      }
    }
    // Apply newly received official warnings even without fresh station data.
    for (const e of this.state.events) {
      const matches = official.filter(a => a.hazard === e.hazard && a.cells.includes(e.cell)
        && a.start < e.expires && a.end > e.at);
      if (matches.length) { e.status = 'suppressed_by_official'; e.official = structuredClone(matches); }
    }
    return emitted;
  }
}
// 0.1-degree cells bound the corroboration footprint (~16km diagonal at equator).
export function validCell(cell: string): boolean {
  if (typeof cell !== 'string' || !/^-?\d{1,3}\.\d,-?\d{1,3}\.\d$/.test(cell)) return false;
  const [lat, lon] = cell.split(',').map(Number);
  return lat >= -90 && lat < 90 && lon >= -180 && lon < 180;
}
function ratio(r: VerifiedReading, h: Hazard, c: RegionConfig): number | null {
  const fields = h === 'rain' ? [[r.rainRateMmH, c.rainRateMmH], [r.rainHourMm, c.rainHourMm]]
    : h === 'heat' ? [[r.heatIndexC, c.heatIndexC]] : [[r.gustMs, c.gustMs]];
  const ratios = fields.filter(([v]) => typeof v === 'number' && Number.isFinite(v) && v! >= 0)
    .map(([v, threshold]) => v! / threshold!);
  return ratios.length ? Math.max(...ratios) : null;
}
