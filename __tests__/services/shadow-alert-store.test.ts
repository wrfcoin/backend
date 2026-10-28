import { ShadowAlertStore } from '../../server/services/weather/shadow-alert-store';
import { emptyShadowState, RESEARCH_DEFAULTS } from '../../server/services/weather/shadow-alert-engine';
const old = process.env.ALERT_ENGINE_SHADOW;
afterEach(() => { if (old === undefined) delete process.env.ALERT_ENGINE_SHADOW; else process.env.ALERT_ENGINE_SHADOW = old; });
test('flag off never acquires database or sender', async () => {
  delete process.env.ALERT_ENGINE_SHADOW;
  const pool = { connect: jest.fn(), query: jest.fn() };
  expect(await new ShadowAlertStore(pool as any).evaluate({}, 0, [], [])).toEqual([]);
  expect(pool.connect).not.toHaveBeenCalled();
});
test('state update commits atomically under a row lock', async () => {
  process.env.ALERT_ENGINE_SHADOW = '1';
  const query = jest.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ state: emptyShadowState() }] : [] }));
  const release = jest.fn(); const pool = { connect: async () => ({ query, release }) };
  await new ShadowAlertStore(pool as any).evaluate({ research: RESEARCH_DEFAULTS }, 0, [], []);
  expect(query.mock.calls.map(c => c[0])).toEqual(['BEGIN', expect.stringContaining('INSERT'), expect.stringContaining('FOR UPDATE'), expect.stringContaining('UPDATE'), 'COMMIT']);
  expect(release).toHaveBeenCalledTimes(1);
});
test('failed persistence rolls back and releases', async () => {
  process.env.ALERT_ENGINE_SHADOW = '1';
  const query = jest.fn(async (sql: string) => { if (sql.startsWith('UPDATE')) throw new Error('disk'); return { rows: [{ state: emptyShadowState() }] }; });
  const release = jest.fn();
  await expect(new ShadowAlertStore({ connect: async () => ({ query, release }) } as any).evaluate({}, 0, [], [])).rejects.toThrow('disk');
  expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledTimes(1);
});
