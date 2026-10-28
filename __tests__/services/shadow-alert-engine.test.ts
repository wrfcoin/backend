import { ShadowAlertEngine, emptyShadowState, RESEARCH_DEFAULTS, VerifiedReading, OfficialAlert } from '../../server/services/weather/shadow-alert-engine';
const now = 1_800_000_000_000;
const cell = '0.0,36.0';
const reading = (station = 'station-01', extra = {}): VerifiedReading => ({ station, cell, region: 'research', at: now,
  verification: 'verified', qualityTier: 'good', referenceAvailable: true, gustMs: 30, ...extra });
const official = (extra = {}): OfficialAlert => ({ id: 'official-1', url: 'https://example.org/warning', hazard: 'wind', cells: [cell], start: now, end: now + 60000, ...extra });
const engine = () => new ShadowAlertEngine({ research: RESEARCH_DEFAULTS }, emptyShadowState(), true);
test('single uncorroborated reading never emits', () => expect(engine().evaluate(now, [reading()], [])).toEqual([]));
test.each(['degraded', 'outlier'])('below trust tier %s never emits', qualityTier => {
  expect(engine().evaluate(now, [reading('s1', { qualityTier }), reading('s2', { qualityTier })], [])).toEqual([]);
});
test.each([{ verification: 'pending' }, { referenceAvailable: false }, { at: now + 1 }, { at: now - 600001 }, { gustMs: NaN }])('invalid/unverified evidence never emits %j', extra => {
  expect(engine().evaluate(now, [reading('s1', extra), reading('s2', extra)], [])).toEqual([]);
});
test('repeated station packets do not corroborate', () => expect(engine().evaluate(now, [reading(), reading()], [])).toEqual([]));
test('stations in separate cells do not corroborate', () => expect(engine().evaluate(now, [reading(), reading('s2', { cell: '1.0,36.0' })], [])).toEqual([]));
test('official overlap suppresses', () => {
  const result = engine().evaluate(now, [reading(), reading('s2')], [official()]);
  expect(result).toHaveLength(1); expect(result[0].status).toBe('suppressed_by_official'); expect(result[0].official[0].id).toBe('official-1');
});
test.each([{ cells: ['1.0,36.0'] }, { hazard: 'rain' }, { end: now, start: now - 1000 }, { start: now + 600000, end: now + 700000 }])('non-overlap does not suppress %j', extra => {
  expect(engine().evaluate(now, [reading(), reading('s2')], [official(extra)])[0].status).toBe('advisory');
});
test('late official warning supersedes existing advisory', () => {
  const e = engine(); e.evaluate(now, [reading(), reading('s2')], []);
  e.evaluate(now + 1, [], [official()]); expect(e.state.events[0].status).toBe('suppressed_by_official');
});
test('malformed official coverage rejects', () => expect(() => engine().evaluate(now, [reading()], [official({ end: NaN })])).toThrow());
test('cooldown never re-emits hazard and cell after clearing', () => {
  const e = engine(); expect(e.evaluate(now, [reading(), reading('s2')], [])).toHaveLength(1);
  e.evaluate(now + 1, [reading('s1', { at: now + 1, gustMs: 0 }), reading('s2', { at: now + 1, gustMs: 0 })], []);
  expect(e.evaluate(now + 2, [reading(), reading('s2')], [])).toHaveLength(0);
});
test('stuck sensors stay latched beyond cooldown; clear readings rearm', () => {
  const e = engine(); e.evaluate(now, [reading(), reading('s2')], []);
  const later = now + 3600001;
  expect(e.evaluate(later, [reading('s1', { at: later }), reading('s2', { at: later })], [])).toEqual([]);
  e.evaluate(later + 1, [reading('s1', { at: later + 1, gustMs: 0 }), reading('s2', { at: later + 1, gustMs: 0 })], []);
  expect(e.evaluate(later + 2, [reading('s1', { at: later + 2 }), reading('s2', { at: later + 2 })], [])).toHaveLength(1);
});
test('verified covering forecast corroborates one station', () => {
  expect(engine().evaluate(now, [reading()], [], [{ hazard: 'wind', cell, start: now, end: now + 1, verified: true }])).toHaveLength(1);
});
test.each([{ rainRateMmH: 31, gustMs: 0 }, { rainHourMm: 31, gustMs: 0 }, { heatIndexC: 41, gustMs: 0 }])('hazards trigger %j', extra => {
  expect(engine().evaluate(now, [reading('s1', extra), reading('s2', extra)], [])).toHaveLength(1);
});
test('default off', () => {
  const old = process.env.ALERT_ENGINE_SHADOW; delete process.env.ALERT_ENGINE_SHADOW;
  try { expect(new ShadowAlertEngine({ research: RESEARCH_DEFAULTS }, emptyShadowState()).evaluate(now, [reading(), reading('s2')], [])).toEqual([]); }
  finally { if (old !== undefined) process.env.ALERT_ENGINE_SHADOW = old; }
});
test('invalid config rejects', () => expect(() => new ShadowAlertEngine({ research: { ...RESEARCH_DEFAULTS, stations: 1 } }, emptyShadowState(), true)).toThrow());
test('no sender is constructed', () => {
  const sender = jest.fn(() => { throw new Error('sender constructed'); });
  jest.isolateModules(() => {
    jest.doMock('twilio', () => sender);
    jest.doMock('../../server/services/sms-service', () => ({ SMSService: sender }));
    const { ShadowAlertEngine: Engine } = require('../../server/services/weather/shadow-alert-engine');
    const e = new Engine({ research: RESEARCH_DEFAULTS }, emptyShadowState(), true);
    e.evaluate(now, [reading(), reading('s2')], []); e.evaluate(now + 1, [], [official()]);
    expect(sender).not.toHaveBeenCalled();
  });
});
