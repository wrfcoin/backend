import { replay } from '../../server/services/weather/alert-replay';
import { RESEARCH_DEFAULTS } from '../../server/services/weather/shadow-alert-engine';
const fixture = require('../fixtures/alerts/synthetic.json');
test('synthetic confusion matrix is computed per hazard', () => {
  const result = replay(fixture.windows, fixture.configs);
  for (const m of Object.values(result.metrics)) expect(m).toEqual({ tp: 1, fp: 1, fn: 1, tn: 1, unknown: 0, precision: .5, recall: .5, falseAlarmRatio: .5, falsePositiveRate: .5 });
});
test('empty history produces unavailable metrics, not zero false alarms', () => {
  for (const m of Object.values(replay([], { research: RESEARCH_DEFAULTS }).metrics)) {
    expect(m.precision).toBeNull(); expect(m.recall).toBeNull(); expect(m.falseAlarmRatio).toBeNull();
  }
});
test('unknown outcome is not treated as a negative', () => {
  const window = { ...fixture.windows[0], observedOutcome: null };
  expect(replay([window], fixture.configs).metrics.rain.unknown).toBe(1);
});
