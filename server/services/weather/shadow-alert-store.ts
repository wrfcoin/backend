import type { pool } from '../../db.js';
type Pool = typeof pool;
import { ShadowAlertEngine, emptyShadowState, type RegionConfig, type VerifiedReading, type OfficialAlert, type ForecastSignal, type ShadowEvent } from './shadow-alert-engine.js';
/** Persist the evaluator and its cooldown state atomically. Never calls a sender. */
export class ShadowAlertStore {
  constructor(private readonly pool: Pool) {}
  async evaluate(configs: Record<string, RegionConfig>, at: number, readings: VerifiedReading[], official: OfficialAlert[], forecasts: ForecastSignal[] = []): Promise<ShadowEvent[]> {
    if (process.env.ALERT_ENGINE_SHADOW !== '1') return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO alert_shadow_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(emptyShadowState())]);
      const result = await client.query('SELECT state FROM alert_shadow_state WHERE id = 1 FOR UPDATE');
      const engine = new ShadowAlertEngine(configs, result.rows[0].state as import('./shadow-alert-engine.js').ShadowState, true);
      const events = engine.evaluate(at, readings, official, forecasts);
      await client.query('UPDATE alert_shadow_state SET state = $1::jsonb WHERE id = 1', [JSON.stringify(engine.state)]);
      await client.query('COMMIT');
      return events;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async list(): Promise<ShadowEvent[]> {
    if (process.env.ALERT_ENGINE_SHADOW !== '1') return [];
    const result = await this.pool.query('SELECT state FROM alert_shadow_state WHERE id = 1');
    return ((result.rows[0]?.state as import('./shadow-alert-engine.js').ShadowState | undefined)?.events || []).slice(-200);
  }
}
