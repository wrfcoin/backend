import { createHmac } from 'node:crypto';
import { DryRunSender, type SmsGatewayInbound } from './sms-gateway.js';
import { validCell, type Hazard, type ShadowEvent } from './weather/shadow-alert-engine.js';
export type Language = 'en' | 'fr';
export interface AlertSubscription {
  phoneHash: string; cell: string; hazards: Hazard[]; language: Language;
  confirmed: boolean; stopped: boolean; createdAt: number; expiresAt: number;
  consent: Array<{ action: 'requested' | 'confirmed' | 'stopped'; at: number }>;
}
export interface SmsResearchState {
  subscriptions: Record<string, AlertSubscription>;
  counts: Record<string, number>; seen: Record<string, boolean>;
}
const words = { en: { rain: 'Heavy rain', heat: 'Heat', wind: 'Strong wind' }, fr: { rain: 'Forte pluie', heat: 'Chaleur', wind: 'Vent fort' } };
export function renderAlertSms(hazard: Hazard, cell: string, language: Language, start: number, end: number, officialUrl: string): string {
  if (!validCell(cell) || !words[language]?.[hazard] || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
    || !/^https:\/\/[A-Za-z0-9./_-]+$/.test(officialUrl)) throw new Error('Invalid template inputs');
  const window = `${new Date(start).toISOString().slice(0, 16)}-${new Date(end).toISOString().slice(11, 16)}Z`;
  const text = `${language === 'en' ? 'Advisory' : 'Avis'}: ${words[language][hazard]}. ${cell} ${window}. ${language === 'en' ? 'Official' : 'Officiel'}: ${officialUrl}. STOP`;
  // Conservative subset of GSM-7: no extension characters (each would consume two septets).
  if (!/^[A-Za-z0-9 .,:/\-]+$/.test(text) || text.length > 160) throw new Error('Template exceeds single GSM-7 segment');
  return text;
}
/** Offline previews only. No endpoint accepts unauthenticated opt-in confirmations. */
export class AlertSmsDryRun {
  readonly sender = new DryRunSender();
  constructor(readonly state: SmsResearchState, private readonly hashKey: Buffer,
    readonly perNumberDay = 2, readonly globalDay = 100, readonly budgetCents = 0,
    readonly costCents = 5) {
    if (hashKey.length < 32 || ![perNumberDay, globalDay, budgetCents, costCents].every(Number.isFinite)
      || !Number.isInteger(perNumberDay) || !Number.isInteger(globalDay)
      || perNumberDay < 0 || globalDay < 0 || budgetCents < 0 || costCents <= 0) throw new Error('Invalid dry-run policy');
    if (process.env.ALERT_SMS_DELIVERY && process.env.ALERT_SMS_DELIVERY !== '0') throw new Error('Real SMS delivery is unsupported');
  }
  hash(phone: string): string {
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('E.164 required');
    return createHmac('sha256', this.hashKey).update(phone).digest('hex');
  }
  subscribe(phone: string, cell: string, hazards: Hazard[], language: Language, at: number): string {
    if (!validCell(cell) || !['en', 'fr'].includes(language) || !hazards.length || hazards.some(h => !['rain', 'heat', 'wind'].includes(h)) || !Number.isFinite(at)) throw new Error('Invalid subscription');
    const phoneHash = this.hash(phone);
    // Repeat requests cannot erase STOP or manufacture confirmation.
    if (this.state.subscriptions[phoneHash]) return phoneHash;
    if (Object.keys(this.state.subscriptions).length >= 1000) throw new Error('Research subscription cap');
    this.state.subscriptions[phoneHash] = { phoneHash, cell, hazards: [...new Set(hazards)], language,
      confirmed: false, stopped: false, createdAt: at, expiresAt: at + 30 * 86400000, consent: [{ action: 'requested', at }] };
    return phoneHash;
  }
  // The gateway adapter must authenticate the sender's identity before passing true.
  control(input: SmsGatewayInbound, authenticated: boolean, at: number): boolean {
    const keyword = input.text.trim().toUpperCase();
    if (!['STOP', 'YES'].includes(keyword) || !authenticated || !Number.isFinite(at)) return false;
    const sub = this.state.subscriptions[this.hash(input.sender)];
    if (!sub || at < sub.createdAt) return false;
    if (keyword === 'STOP') { sub.stopped = true; sub.confirmed = false; sub.consent.push({ action: 'stopped', at }); return true; }
    if (sub.stopped || at >= sub.expiresAt) return false;
    if (!sub.confirmed) sub.consent.push({ action: 'confirmed', at });
    sub.confirmed = true; return true;
  }
  preview(event: ShadowEvent, officialUrl: string, now: number): number {
    if (!Number.isFinite(now) || event.status !== 'advisory' || !event.shadow || event.at > now || event.expires <= now) return 0;
    const day = Math.floor(now / 86400000); let sent = 0;
    for (const sub of Object.values(this.state.subscriptions)) {
      if (!sub.confirmed || sub.stopped || now >= sub.expiresAt || sub.cell !== event.cell || !sub.hazards.includes(event.hazard)) continue;
      const perKey = `${day}:${sub.phoneHash}`, globalKey = `${day}:global`, duplicate = `${sub.phoneHash}:${event.id}`;
      if (this.state.seen[duplicate] || (this.state.counts[perKey] || 0) >= this.perNumberDay
        || (this.state.counts[globalKey] || 0) >= this.globalDay
        || ((this.state.counts[globalKey] || 0) + 1) * this.costCents > this.budgetCents) continue;
      const text = renderAlertSms(event.hazard, event.cell, sub.language, event.at, event.expires, officialUrl);
      this.sender.record({ recipientHash: sub.phoneHash, eventId: event.id, text, at: now });
      this.state.counts[perKey] = (this.state.counts[perKey] || 0) + 1;
      this.state.counts[globalKey] = (this.state.counts[globalKey] || 0) + 1;
      this.state.seen[duplicate] = true; sent++;
    }
    return sent;
  }
  purge(now: number): void {
    for (const [hash, sub] of Object.entries(this.state.subscriptions)) if (now >= sub.expiresAt) {
      delete this.state.subscriptions[hash];
      for (const key of Object.keys(this.state.seen)) if (key.startsWith(`${hash}:`)) delete this.state.seen[key];
    }
    const today = Math.floor(now / 86400000);
    for (const key of Object.keys(this.state.counts)) if (Number(key.split(':')[0]) < today) delete this.state.counts[key];
    this.sender.previews.splice(0, this.sender.previews.length);
  }
}

/** Transaction boundary for durable offline research; no HTTP or vendor adapter. */
export class AlertSmsResearchStore {
  constructor(private readonly pool: typeof import('../db.js').pool) {}
  async run<T>(hashKey: Buffer, action: (service: AlertSmsDryRun) => T, now: number): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO alert_sms_research_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify({ subscriptions: {}, counts: {}, seen: {} })]);
      const rows = await client.query('SELECT state FROM alert_sms_research_state WHERE id = 1 FOR UPDATE');
      const service = new AlertSmsDryRun(rows.rows[0].state as SmsResearchState, hashKey);
      service.purge(now);
      const result = action(service);
      if (result && typeof (result as any).then === 'function') throw new Error('Research action must be synchronous');
      await client.query('UPDATE alert_sms_research_state SET state = $1::jsonb WHERE id = 1', [JSON.stringify(service.state)]);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
