import { createUsageCountsRouter, lastUtcDays, readUsageCounts } from '../../server/routes/usage-counts-routes.js';

// Fixtures only: no database, no network.
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const CHAIN = { chainId: '888', genesis: 'a'.repeat(64) };
const ADDRESS = '0x' + 'ab'.repeat(20);

type Call = { sql: string; params?: unknown[] };

function fakeDb(overrides: Partial<Record<string, () => Record<string, unknown>[]>> = {}) {
  const calls: Call[] = [];
  const pick = (sql: string): string => {
    if (sql.includes('FROM wallets')) return 'wallets';
    if (sql.includes('FROM mobile_station_registrations')) return 'phones';
    if (sql.includes('NOT contribution_scanned')) return 'complete';
    if (sql.includes('WITH weeks')) return 'returners';
    if (sql.includes('FROM chain_contribution_payees')) return 'perDay';
    if (sql.includes('FROM weather_data')) return 'readings';
    throw new Error('unexpected query');
  };
  const defaults: Record<string, () => Record<string, unknown>[]> = {
    // Extra columns a careless SELECT * would leak; the route must not copy them.
    wallets: () => [{ total: '5', new_7d: '2', seen_7d: '4', address: ADDRESS }],
    phones: () => [{ total: '3', waiting: '1', submitted: '0', on_chain: '2', new_7d: '3', owner_address: ADDRESS }],
    complete: () => [{ complete: true }],
    returners: () => [{ this_week: '3', last_week: '2', returned: '1' }],
    perDay: () => [
      { day: '2026-11-07', settled: '40', contributors: '2', contributor_address: ADDRESS },
      { day: new Date(Date.UTC(2026, 10, 8)), settled: 7, contributors: 1 },
    ],
    readings: () => [{ day: '2026-11-08', readings: '12', latitude: '37.1' }],
  };
  return {
    calls,
    db: {
      execute: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const key = pick(sql);
        return { rows: (overrides[key] ?? defaults[key])() };
      },
    },
  };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
    set(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
  };
  return res;
}

async function get(router: any) {
  const layer = router.stack.find((l: any) => l.route && l.route.path === '/' && l.route.methods.get);
  const res = mockRes();
  for (const { handle } of layer.route.stack) {
    let advanced = false;
    await handle({ headers: {} }, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

describe('usage counts', () => {
  it('lists 14 UTC days, oldest first, ending today', () => {
    const days = lastUtcDays(NOW, 14);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-10-26');
    expect(days[13]).toBe('2026-11-08');
  });

  it('returns counts only: no address, station or coordinate anywhere in the output', async () => {
    const { db } = fakeDb();
    const out = await readUsageCounts(db, CHAIN, NOW);
    const text = JSON.stringify(out);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(text).not.toMatch(/address|latitude|longitude|station_id|mob-/i);
    expect(out.wallets).toEqual({ total: 5, newLast7Days: 2, seenLast7Days: 4 });
    expect(out.phoneStations).toEqual({ registered: 3, waitingForActivation: 1, submitted: 0, active: 2, newLast7Days: 3 });
    expect(out.returners).toEqual({ activeThisWeek: 3, activeLastWeek: 2, returnedFromLastWeek: 1 });
    expect(out.contributions?.indexComplete).toBe(true);
    expect(out.contributions?.perDay).toHaveLength(14);
    expect(out.contributions?.perDay.at(-2)).toEqual({ day: '2026-11-07', settledContributions: 40, contributors: 2 });
    expect(out.contributions?.perDay.at(-1)).toEqual({ day: '2026-11-08', settledContributions: 7, contributors: 1 });
    expect(out.contributions?.perDay[0]).toEqual({ day: '2026-10-26', settledContributions: 0, contributors: 0 });
    expect(out.stationReadings?.at(-1)).toEqual({ day: '2026-11-08', readings: 12 });
    expect(out.unavailable).toEqual([]);
  });

  it('splits the returner weeks at the 8th of 14 days and scopes queries to the chain', async () => {
    const { db, calls } = fakeDb();
    await readUsageCounts(db, CHAIN, NOW);
    const returners = calls.find((c) => c.sql.includes('WITH weeks'))!;
    expect(returners.params).toEqual(['888', CHAIN.genesis, '2026-10-26', '2026-11-02']);
    const perDay = calls.find((c) => c.sql.includes('GROUP BY day'))!;
    expect(perDay.params).toEqual(['888', CHAIN.genesis, '2026-10-26']);
  });

  it('marks chain sections unavailable when the reward index is not configured, and still answers the rest', async () => {
    const { db, calls } = fakeDb();
    const out = await readUsageCounts(db, null, NOW);
    expect(out.contributions).toBeNull();
    expect(out.returners).toBeNull();
    expect(out.wallets?.total).toBe(5);
    expect(out.unavailable).toEqual(['contributions', 'returners']);
    expect(calls.some((c) => c.sql.includes('chain_contribution_payees'))).toBe(false);
  });

  it('isolates a failing table to its own section', async () => {
    const { db } = fakeDb({
      phones: () => {
        throw new Error('relation "mobile_station_registrations" does not exist');
      },
    });
    const out = await readUsageCounts(db, CHAIN, NOW);
    expect(out.phoneStations).toBeNull();
    expect(out.unavailable).toEqual(['phoneStations']);
    expect(JSON.stringify(out)).not.toContain('does not exist');
  });

  it('reports an incomplete chain index instead of hiding it', async () => {
    const { db } = fakeDb({ complete: () => [{ complete: false }] });
    const out = await readUsageCounts(db, CHAIN, NOW);
    expect(out.contributions?.indexComplete).toBe(false);
  });
});

describe('usage counts route', () => {
  it('refuses without the operator token (real middleware, token not configured)', async () => {
    const saved = process.env.WRFCOIN_OPERATOR_TOKEN;
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    try {
      const { db, calls } = fakeDb();
      const res = await get(createUsageCountsRouter({ db, rewardChain: () => CHAIN, now: () => NOW }));
      expect(res.statusCode).toBe(503);
      expect(calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.WRFCOIN_OPERATOR_TOKEN = saved;
    }
  });

  it('refuses a wrong bearer and admits the right one', async () => {
    const saved = process.env.WRFCOIN_OPERATOR_TOKEN;
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-test-token';
    try {
      const { db } = fakeDb();
      const router = createUsageCountsRouter({ db, rewardChain: () => CHAIN, now: () => NOW });
      const layer = router.stack.find((l: any) => l.route && l.route.path === '/').route;
      const run = async (authorization?: string) => {
        const res = mockRes();
        for (const { handle } of layer.stack) {
          let advanced = false;
          await handle({ headers: authorization ? { authorization } : {} }, res, () => {
            advanced = true;
          });
          if (!advanced) break;
        }
        return res;
      };
      expect((await run()).statusCode).toBe(401);
      expect((await run('Bearer wrong-token-value')).statusCode).toBe(403);
      const ok = await run('Bearer operator-test-token');
      expect(ok.statusCode).toBe(200);
      expect(ok.body.success).toBe(true);
      expect(ok.body.data.wallets.total).toBe(5);
      expect(ok.headers['Cache-Control']).toBe('no-store');
    } finally {
      if (saved === undefined) delete process.env.WRFCOIN_OPERATOR_TOKEN;
      else process.env.WRFCOIN_OPERATOR_TOKEN = saved;
    }
  });

  it('caches for a minute', async () => {
    const { db, calls } = fakeDb();
    let at = NOW;
    const router = createUsageCountsRouter({ db, rewardChain: () => CHAIN, now: () => at, auth: (_q, _s, next) => next() });
    await get(router);
    const first = calls.length;
    at += 30_000;
    await get(router);
    expect(calls.length).toBe(first);
    at += 31_000;
    await get(router);
    expect(calls.length).toBe(first * 2);
  });
});
