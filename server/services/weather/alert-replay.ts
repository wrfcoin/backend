import { ShadowAlertEngine, emptyShadowState, type Hazard, type RegionConfig, type VerifiedReading, type OfficialAlert } from './shadow-alert-engine.js';
export interface ReplayWindow {
  at: number; cell: string; hazard: Hazard; readings: VerifiedReading[];
  official: OfficialAlert[]; observedOutcome: boolean | null;
}
export function replay(windows: ReplayWindow[], configs: Record<string, RegionConfig>) {
  const engine = new ShadowAlertEngine(configs, emptyShadowState(), true);
  const counts = Object.fromEntries((['rain', 'heat', 'wind'] as Hazard[]).map(h => [h, { tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0 }])) as Record<Hazard, { tp: number; fp: number; fn: number; tn: number; unknown: number }>;
  let lastAt = -Number.MAX_VALUE;
  for (const w of windows) {
    if (!counts[w.hazard] || !Number.isFinite(w.at) || w.at < lastAt) throw new Error('Replay windows must be chronological');
    lastAt = w.at;
    engine.evaluate(w.at, w.readings, w.official);
    const positiveOfficial = w.official.some(a => a.hazard === w.hazard && a.cells.includes(w.cell) && a.start <= w.at && w.at < a.end);
    const truth = positiveOfficial ? true : w.observedOutcome;
    const c = counts[w.hazard];
    if (truth === null) { c.unknown++; continue; }
    if (typeof truth !== 'boolean') throw new Error('Missing outcome label');
    // Score the detector, including suppressed events; also retain suppression for audit.
    const detected = engine.state.events.some(e => e.hazard === w.hazard && e.cell === w.cell && e.at <= w.at && w.at < e.expires);
    if (detected) truth ? c.tp++ : c.fp++;
    else truth ? c.fn++ : c.tn++;
  }
  const divide = (n: number, d: number) => d ? n / d : null;
  return { configs, windows: windows.length, events: engine.state.events, metrics: Object.fromEntries(Object.entries(counts).map(([h, c]) => [h, {
    ...c, precision: divide(c.tp, c.tp + c.fp), recall: divide(c.tp, c.tp + c.fn),
    falseAlarmRatio: divide(c.fp, c.tp + c.fp), falsePositiveRate: divide(c.fp, c.fp + c.tn),
  }])) };
}
