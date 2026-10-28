import { randomBytes } from 'node:crypto';
import { AlertSmsDryRun, renderAlertSms } from '../../server/services/alert-sms-dry-run';
import type { ShadowEvent } from '../../server/services/weather/shadow-alert-engine';
const at = 1800000000000, phone = '+15550000001', cell = '0.0,36.0';
const event = (id = 'e1'): ShadowEvent => ({ id, at, expires: at + 600000, region: 'research', cell, hazard: 'wind', status: 'advisory', official: [], stations: ['s1', 's2'], confidence: 'corroborated', shadow: true });
function service(budget = 100, cap = 2, global = 100) { return new AlertSmsDryRun({ subscriptions: {}, counts: {}, seen: {} }, randomBytes(32), cap, global, budget); }
function confirm(s: AlertSmsDryRun, number = phone) { s.subscribe(number, cell, ['wind'], 'en', at); s.control({ messageId: 'consent', sender: number, text: 'YES' }, true, at); }
test('unconfirmed subscribers never receive a preview', () => { const s = service(); s.subscribe(phone, cell, ['wind'], 'en', at); expect(s.preview(event(), 'https://example.org', at)).toBe(0); });
test('STOP is immediate and cannot be undone by duplicate subscribe or YES', () => {
  const s = service(); confirm(s); expect(s.preview(event(), 'https://example.org', at)).toBe(1);
  expect(s.control({ messageId: 'stop', sender: phone, text: ' stop ' }, true, at)).toBe(true);
  confirm(s); expect(s.preview(event('e2'), 'https://example.org', at)).toBe(0);
});
test('unauthenticated YES cannot confirm', () => {
  const s = service(); const hash = s.subscribe(phone, cell, ['wind'], 'en', at);
  expect(s.control({ messageId: 'spoof', sender: phone, text: 'YES' }, false, at)).toBe(false);
  expect(s.state.subscriptions[hash].confirmed).toBe(false);
});
test('per-number daily cap and deduplication hold', () => {
  const s = service(100, 1); confirm(s); expect(s.preview(event(), 'https://example.org', at)).toBe(1);
  expect(s.preview(event(), 'https://example.org', at)).toBe(0); expect(s.preview(event('e2'), 'https://example.org', at)).toBe(0);
});
test('global daily cap holds across numbers', () => {
  const s = service(100, 2, 1); confirm(s); confirm(s, '+15550000002');
  expect(s.preview(event(), 'https://example.org', at)).toBe(1);
});
test('budget cap holds and zero budget means zero previews', () => {
  for (const budget of [0, 4]) { const s = service(budget); confirm(s); expect(s.preview(event(), 'https://example.org', at)).toBe(0); }
});
test('official-suppressed or expired events never preview', () => {
  const s = service(); confirm(s); expect(s.preview({ ...event(), status: 'suppressed_by_official' }, 'https://example.org', at)).toBe(0);
  expect(s.preview(event(), 'https://example.org', at + 600000)).toBe(0);
});
test.each(['en', 'fr'] as const)('all %s templates fit one GSM-7 segment', language => {
  for (const hazard of ['rain', 'heat', 'wind'] as const) {
    const text = renderAlertSms(hazard, '-89.9,-179.9', language, at, at + 600000, 'https://example.org/warnings');
    expect(text.length).toBeLessThanOrEqual(160); expect(text).toMatch(/^[A-Za-z0-9 .,:/\-]+$/);
  }
});
test('oversized and non-GSM source pointers reject instead of truncating', () => {
  expect(() => renderAlertSms('rain', cell, 'fr', at, at + 1, `https://example.org/${'a'.repeat(150)}`)).toThrow();
  expect(() => renderAlertSms('rain', cell, 'fr', at, at + 1, 'https://example.org/é')).toThrow();
});
test('storage and previews never contain plaintext numbers; retention expires consent', () => {
  const s = service(); confirm(s); s.preview(event(), 'https://example.org', at);
  expect(JSON.stringify(s.state)).not.toContain(phone); expect(JSON.stringify(s.sender.previews)).not.toContain(phone);
  s.purge(at + 30 * 86400000); expect(s.state.subscriptions).toEqual({}); expect(s.sender.previews).toEqual([]);
});
test('real delivery flag is rejected', () => {
  const old = process.env.ALERT_SMS_DELIVERY; process.env.ALERT_SMS_DELIVERY = '1';
  try { expect(() => service()).toThrow('unsupported'); }
  finally { if (old === undefined) delete process.env.ALERT_SMS_DELIVERY; else process.env.ALERT_SMS_DELIVERY = old; }
});
