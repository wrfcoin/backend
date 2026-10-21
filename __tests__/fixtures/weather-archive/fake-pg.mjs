// In-memory stand-in for the `pg` package: serves SYNTHETIC released weather cells (acceptance test only).
import { appendFileSync } from 'node:fs';

export const ROWS = [
  { lat_e1: 449, lon_e1: -933, min_c: '12.5', max_c: '21', mean_c: '16.5', count_bucket: 30 },
  { lat_e1: 450, lon_e1: -933, min_c: 11, max_c: 19.5, mean_c: 15, count_bucket: 20 },
  { lat_e1: 451, lon_e1: -932, min_c: null, max_c: null, mean_c: null, count_bucket: null }, // suppressed cell
  { lat_e1: 452, lon_e1: -931, min_c: 9, max_c: 18, mean_c: 13.5, count_bucket: 10 },
];

export class Pool {
  constructor(options) { this.options = options; }
  async query(sql, parameters) {
    appendFileSync(process.env.WRFCOIN_FAKE_PG_LOG, `${JSON.stringify({ sql: String(sql).trim().split('\n')[0], parameters })}\n`);
    if (/weather_temperature_daily_release/.test(sql) && /WHERE day = \$1::date/.test(sql)) return { rows: ROWS };
    return { rows: [] };
  }
  async end() {}
}
export default { Pool };
