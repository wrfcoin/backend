import {
  checkInUser,
  computeStreaksFromDateKeys,
  getStreakSummary,
  resolveDateKey,
} from '../server/services/streak-service.js';

describe('streak-service helpers', () => {
  it('boots the streak schema once across summary and check-in calls', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2026-03-09T12:00:00.000Z')
    );
    try {
      const execute = jest.fn(async (sql: string) => {
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
          return { rows: [] };
        }

        if (sql.startsWith('SELECT date_key')) {
          return { rows: [{ date_key: '2026-03-09' }] };
        }

        if (sql.startsWith('SELECT milestone_days')) {
          return { rows: [] };
        }

        if (sql.startsWith('INSERT INTO streak_checkins')) {
          return { rows: [{ user_id: 42 }] };
        }

        return { rows: [] };
      });
      const db = { execute };

      const summary = await getStreakSummary(42, 0, db);
      const checkIn = await checkInUser(42, 0, db);

      const ddlCalls = execute.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' && sql.startsWith('CREATE TABLE IF NOT EXISTS')
      );

      expect(summary.currentStreak).toBe(1);
      expect(checkIn.checkedIn).toBe(true);
      expect(ddlCalls).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('computes current and longest streak for contiguous dates', () => {
    const keys = ['2026-03-07', '2026-03-08', '2026-03-09'];
    const result = computeStreaksFromDateKeys(keys, '2026-03-09');
    expect(result.currentStreak).toBe(3);
    expect(result.longestStreak).toBe(3);
  });

  it('resets current streak when today is missing but preserves longest', () => {
    const keys = ['2026-03-01', '2026-03-02', '2026-03-05'];
    const result = computeStreaksFromDateKeys(keys, '2026-03-06');
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(2);
  });

  it('handles timezone boundary through date key resolution', () => {
    const utcMidnightMinusOneMinute = Date.parse('2026-03-10T23:59:00.000Z');
    const plus120 = resolveDateKey(utcMidnightMinusOneMinute, 120); // local next day
    const minus300 = resolveDateKey(utcMidnightMinusOneMinute, -300); // local same day

    expect(plus120).toBe('2026-03-11');
    expect(minus300).toBe('2026-03-10');
  });
});
