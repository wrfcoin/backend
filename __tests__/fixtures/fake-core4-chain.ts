import { jest } from '@jest/globals';

export type Reveal = { station: string; height: number; observedAt: number; temperature?: number };

/**
 * Behavioral model of core4 native-chain launch_api routes/transactions.rs
 * get_station_observations: limit clamp 1..100, ascending scan from after+1,
 * at most 64 heights and 1000 transactions per call, envelope {ok,data}.
 * One transaction per reveal; `fillerPerBlock` extra transactions per block
 * model other stations' traffic for the scan cap.
 */
export function fakeCore4Chain(chainHeight: number, reveals: Reveal[], fillerPerBlock = 0) {
  const byHeight = new Map<number, Reveal[]>();
  for (const r of reveals) byHeight.set(r.height, [...(byHeight.get(r.height) ?? []), r]);
  return jest.fn(async (path: string, options: any = {}) => {
    const m = /^\/transactions\/contributions\/([^/]+)\/observations$/.exec(path);
    if (!m) return { ok: false, status: 404, payload: null };
    const station = decodeURIComponent(m[1]);
    const q = options.query ?? {};
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50)));
    let after = Number(q.after ?? 0);
    let offset = Number(q.offset ?? 0);
    const items: any[] = [];
    let scanned = 0;
    let heights = 0;
    while (after < chainHeight && items.length < limit && scanned < 1000 && heights < 64) {
      const height = after + 1;
      const txs = [...Array.from({ length: fillerPerBlock }, () => null), ...(byHeight.get(height) ?? [])];
      heights += 1;
      while (offset < txs.length && items.length < limit && scanned < 1000) {
        const tx = txs[offset];
        offset += 1;
        scanned += 1;
        if (!tx || tx.station !== station) continue;
        items.push({
          commit_id: `c${tx.height.toString(16).padStart(8, '0')}`, station_id: tx.station, height,
          observed_at: tx.observedAt,
          values: { temperature_c: tx.temperature ?? 20, humidity_percent: 50, pressure_hpa: null,
            wind_speed_ms: null, precipitation_mm: null, dewpoint_c: null },
          provenance_class: 'real', attestation: null,
        });
      }
      if (offset === txs.length) { after = height; offset = 0; }
    }
    return {
      ok: true, status: 200,
      payload: { ok: true, data: {
        items, limit, next_after: after, next_offset: offset, has_more: after < chainHeight,
        chain_height: chainHeight, state_tip: 'ab'.repeat(32), scanned_transactions: scanned,
      } },
    };
  });
}
