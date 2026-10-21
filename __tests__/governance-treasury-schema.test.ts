import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mockDbExecute = jest.fn();

jest.mock('../server/db.js', () => ({
  db: {
    execute: mockDbExecute,
    select: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
  },
}));

jest.mock('../shared/governance-schema.js', () => ({
  proposals: {},
  votes: {},
  parameters: {},
  delegations: {},
}));

jest.mock('../shared/schema-governance-consolidated.js', () => ({
  treasuryConsolidated: {},
}));

const injectAdmin = (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { user: unknown }).user = {
    id: 'admin-001',
    address: '0xAdmin',
    role: 'admin',
  };
  next();
};

jest.mock('../server/middleware/authMiddleware.js', () => ({
  requireAuth: injectAdmin,
  requireAdmin: injectAdmin,
}));

jest.mock('../shared/core4-route-client.js', () => ({
  extractCore4Data: (payload: unknown) => payload,
  fetchCore4Json: jest.fn(),
  forwardCore4Headers: () => ({}),
  sendCore4Error: jest.fn(),
  sendCore4Unavailable: jest.fn(),
  toNullable: (value: unknown) => value ?? null,
}));

jest.mock('../utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import drizzleConfig from '../drizzle.config.js';
import { verifySchemaIntegrity } from '../database/schema-verify.js';

const migrationPath = resolve(
  process.cwd(),
  'drizzle/migrations/0019_governance_consolidated.sql',
);
const migrationSql = readFileSync(migrationPath, 'utf8');
const requiredTables = [
  'proposals_consolidated',
  'treasury_consolidated',
  'foundation_consolidated',
  'parameters_consolidated',
] as const;

function assertGovernanceTables(sql: string): void {
  for (const table of requiredTables) {
    expect(sql).toMatch(
      new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+"${table}"`, 'i'),
    );
  }
}

describe('governance consolidated schema migration', () => {
  it('declares every governance-consolidated table', () => {
    assertGovernanceTables(migrationSql);
  });

  it('registers the governance schema with Drizzle', () => {
    expect(drizzleConfig.schema).toContain(
      './shared/schema-governance-consolidated.ts',
    );
  });

  it('reports treasury_consolidated when the migrated table is absent', async () => {
    const db = {
      execute: jest.fn().mockResolvedValue([
        { table_name: 'users' },
        { table_name: 'blocks' },
        { table_name: 'transactions' },
        { table_name: 'wallets' },
        { table_name: 'weather_data' },
        { table_name: 'weather_submissions' },
        { table_name: 'governance_proposals' },
      ]),
    };

    const result = await verifySchemaIntegrity(db);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['treasury_consolidated']);
  });

  it('rejects a migration missing treasury_consolidated', () => {
    const mutated = migrationSql.replace(
      /CREATE TABLE IF NOT EXISTS "treasury_consolidated"[\s\S]*?(?=CREATE TABLE IF NOT EXISTS "foundation_consolidated")/,
      '',
    );

    expect(() => assertGovernanceTables(mutated)).toThrow();
  });
});

describe('GET /governance/treasury', () => {
  it('returns zero totals instead of 500 for an empty migrated table', async () => {
    mockDbExecute.mockResolvedValueOnce([]);
    const { default: governanceRouter } = await import(
      '../server/routes/governance-routes.js'
    );
    const app = express();
    app.use(express.json());
    app.use('/governance', governanceRouter);

    const res = await request(app).get('/governance/treasury');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      balance: '0.00000000',
      totalDeposits: '0.00000000',
      totalWithdrawals: '0.00000000',
      transactionCount: 0,
      amountUnits: {
        denomination: null, baseUnitDecimals: null, baseUnitsPerUnit: null,
        available: false, reason: 'treasury_units_not_established',
        fields: { balance: 'unknown', totalDeposits: 'unknown', totalWithdrawals: 'unknown' },
      },
    });
  });

  it.each([
    ['/governance/treasury', ['balance', 'totalDeposits', 'totalWithdrawals']],
    ['/governance/analytics/treasury', ['balance', 'totalInflow', 'totalOutflow']],
  ])('does not declare generic ledger sums as WRF at %s', async (path, monetaryFields) => {
    mockDbExecute.mockResolvedValueOnce([{ total_deposits: '1234.5', total_withdrawals: '23', total_inflow: '1234.5', total_outflow: '23', transaction_count: 2 }]);
    const { default: governanceRouter } = await import('../server/routes/governance-routes.js');
    const app = express();
    app.use('/governance', governanceRouter);
    const res = await request(app).get(path as string);
    expect(res.status).toBe(200);
    expect(res.body.data.amountUnits).toEqual({
      denomination: null, baseUnitDecimals: null, baseUnitsPerUnit: null,
      available: false, reason: 'treasury_units_not_established',
      fields: Object.fromEntries((monetaryFields as string[]).map(field => [field, 'unknown'])),
    });
    expect(res.body.data.balance).toBe('1211.50000000');
  });
});
