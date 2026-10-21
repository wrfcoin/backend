import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import {
  ACHIEVEMENT_LEDGER_TABLE,
  RESET_TABLES,
  ResetUsageError,
  canonicalIdentity,
  defaultArchiveSchema,
  formatReport,
  parseArgs,
  parseLabels,
  runNewChainReset,
  type ResetDb,
  type ResetOptions,
} from '../server/services/new-chain-reset.js';

const G_OLD = '11'.repeat(32);
const G_NEW = '22'.repeat(32);
const PRODUCER = 'ab'.repeat(32);
const ATTESTER = '0x' + 'cd'.repeat(20);
const base: ResetOptions = { apply: false, fromChainId: '777', toChainId: '888', archiveSchema: 'chain_reset_777_test' };

/** Records every statement; answers counts and existence checks. */
function fakeDb(opts: { missing?: string[]; counts?: Record<string, number>; oldLabels?: any[] } = {}) {
  const log: string[] = [];
  let inTx = false;
  const q = async (text: string, params: unknown[] = []) => {
    log.push(`${inTx ? 'TX ' : ''}${text.replace(/\s+/g, ' ').trim()}`);
    if (text.includes('to_regclass')) {
      const t = String(params[0]).replace('public.', '');
      return [{ present: !(opts.missing ?? []).includes(t) }];
    }
    if (text.startsWith('SELECT count(*)')) {
      const t = /public\."([a-z_]+)"/.exec(text)![1];
      return [{ n: String(opts.counts?.[t] ?? 3) }];
    }
    if (text.includes('FROM pg_namespace')) return [];
    if (text.includes('FROM public.operator_role_labels')) return opts.oldLabels ?? [];
    if (text.includes('RETURNING 1')) return [{ ok: 1 }];
    return [];
  };
  const db: ResetDb = {
    query: q,
    begin: async (fn) => { inTx = true; try { return await fn({ query: q }); } finally { inTx = false; } },
  };
  return { db, log };
}

describe('new-chain reset: arguments and validation', () => {
  it('defaults to a dry run with a dated archive schema', () => {
    const o = parseArgs(['--from-chain-id', '777', '--to-chain-id', '888'], new Date('2026-10-22T19:05:00Z'));
    expect(o.apply).toBe(false);
    expect(o.archiveSchema).toBe('chain_reset_777_202610221905');
    expect(defaultArchiveSchema('777', new Date('2026-01-02T03:04:59Z'))).toBe('chain_reset_777_202601020304');
  });

  it('refuses unknown flags, missing values and bad identifiers', () => {
    expect(() => parseArgs(['--from-chain-id', '777'], new Date())).toThrow(ResetUsageError);
    expect(() => parseArgs(['--from-chain-id', '777', '--to-chain-id', '888', '--force'], new Date())).toThrow('unknown argument');
    expect(() => parseArgs(['--from-chain-id', '--to-chain-id', '888'], new Date())).toThrow('needs a value');
    return Promise.all([
      expect(runNewChainReset(fakeDb().db, { ...base, toChainId: '777' })).rejects.toThrow('must differ'),
      expect(runNewChainReset(fakeDb().db, { ...base, archiveSchema: 'public' })).rejects.toThrow('archive-schema'),
      expect(runNewChainReset(fakeDb().db, { ...base, archiveSchema: 'x"; DROP' })).rejects.toThrow('archive-schema'),
      expect(runNewChainReset(fakeDb().db, { ...base, toGenesisHash: 'AB'.repeat(32) })).rejects.toThrow('64 lowercase hex'),
      expect(runNewChainReset(fakeDb().db, { ...base, copyLabelsFromGenesisHash: G_OLD, labelApprovalReference: 'ok' }))
        .rejects.toThrow('needs --to-genesis-hash'),
      expect(runNewChainReset(fakeDb().db, { ...base, toGenesisHash: G_NEW, copyLabelsFromGenesisHash: G_OLD }))
        .rejects.toThrow('approval-reference'),
    ]);
  });

  it('parses an owner label list into canonical identities and refuses bad rows', () => {
    expect(canonicalIdentity('CD'.repeat(20))).toBe(ATTESTER);
    expect(parseLabels([{ role: 'producer', operator_identity: PRODUCER.toUpperCase(), display_label: 'Mango' }]))
      .toEqual([{ role: 'producer', operator_identity: PRODUCER, display_label: 'Mango' }]);
    expect(() => parseLabels({})).toThrow('JSON array');
    expect(() => parseLabels([{ role: 'producer', operator_identity: ATTESTER, display_label: 'Mango' }])).toThrow('64-hex key');
    expect(() => parseLabels([{ role: 'oracle', operator_identity: PRODUCER, display_label: 'Mango' }])).toThrow('role');
    expect(() => parseLabels([{ role: 'attester', operator_identity: ATTESTER, display_label: 'Laptop' }])).toThrow('display_label');
  });
});

describe('new-chain reset: dry run', () => {
  it('only reads: no DDL, no TRUNCATE, no DELETE, no transaction', async () => {
    const { db, log } = fakeDb({ counts: { weather_commitments: 9 } });
    const r = await runNewChainReset(db, base);
    expect(r.mode).toBe('dry-run');
    expect(log.every(s => s.startsWith('SELECT'))).toBe(true);
    expect(log.some(s => s.startsWith('TX'))).toBe(false);
    expect(r.tables.map(t => t.table)).toEqual([...RESET_TABLES, ACHIEVEMENT_LEDGER_TABLE]);
    expect(r.tables.find(t => t.table === 'weather_commitments')!.rows).toBe(9);
    const text = formatReport(r);
    expect(text).toContain('weather_commitments: 9 rows -> truncate');
    expect(text).toContain('not created in dry run');
  });

  it('reports absent tables and the reward-index env status without printing values', async () => {
    const { db } = fakeDb({ missing: ['blocks'] });
    const unset = await runNewChainReset(db, base);
    expect(unset.tables.find(t => t.table === 'blocks')!.rows).toBeNull();
    expect(unset.rewardIndexEnv).toBe('unset');
    const mism = await runNewChainReset(db, { ...base, toGenesisHash: G_NEW, rewardIndexEnv: { chainId: '777', genesisHash: G_OLD } });
    expect(mism.rewardIndexEnv).toBe('mismatch');
    expect(formatReport(mism)).not.toContain(G_OLD);
    const ok = await runNewChainReset(db, { ...base, toGenesisHash: G_NEW, rewardIndexEnv: { chainId: '888', genesisHash: G_NEW } });
    expect(ok.rewardIndexEnv).toBe('match');
  });
});

describe('new-chain reset: apply (statement plan)', () => {
  it('archives before it truncates, in one transaction, with no CASCADE', async () => {
    const { db, log } = fakeDb({ missing: ['blocks'] });
    const r = await runNewChainReset(db, { ...base, apply: true });
    expect(r.mode).toBe('applied');
    const tx = log.filter(s => s.startsWith('TX ')).map(s => s.slice(3));
    const iSchema = tx.findIndex(s => s.startsWith('CREATE SCHEMA "chain_reset_777_test"'));
    const iTrunc = tx.findIndex(s => s.startsWith('TRUNCATE'));
    const iDelete = tx.findIndex(s => s.startsWith('DELETE FROM public."contributor_rewards"'));
    expect(tx[0]).toContain('lock_timeout');
    expect(iSchema).toBeGreaterThan(0);
    for (const t of RESET_TABLES.filter(t => t !== 'blocks')) {
      const iCopy = tx.findIndex(s => s.startsWith(`CREATE TABLE "chain_reset_777_test"."${t}" AS SELECT * FROM public."${t}"`));
      expect(iCopy).toBeGreaterThan(iSchema);
      expect(iCopy).toBeLessThan(iTrunc);
    }
    expect(tx[iTrunc]).not.toContain('blocks');
    expect(tx[iTrunc]).not.toMatch(/CASCADE/i);
    expect(tx[iDelete]).toContain('contributor_type = \'achievement\'');
    expect(tx.findIndex(s => s.includes('"contributor_rewards_achievement" AS'))).toBeLessThan(iDelete);
    expect(log.filter(s => !s.startsWith('TX ')).every(s => s.startsWith('SELECT'))).toBe(true);
  });

  it('re-seeds labels from the owner list first, then copies only unnamed old rows', async () => {
    const { db, log } = fakeDb({
      oldLabels: [
        { role: 'producer', operator_identity: PRODUCER, display_label: 'N5 node' },
        { role: 'attester', operator_identity: ATTESTER, display_label: 'Workstation' },
      ],
    });
    const r = await runNewChainReset(db, {
      ...base, apply: true, toGenesisHash: G_NEW, copyLabelsFromGenesisHash: G_OLD, labelApprovalReference: ' owner 10-22 ',
      labels: [{ role: 'producer', operator_identity: PRODUCER, display_label: 'Mango' }],
    });
    expect(r.labels).toEqual({ planned: 2, copied: 1, inserted: 2 });
    const inserts = log.filter(s => s.includes('INSERT INTO public.operator_role_labels'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain('VALUES ($1, $2, $3, $4, 1, NULL, $5, $6, now())');
  });
});

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;
if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  describe('new-chain reset against real PostgreSQL', () => {
    it('needs MOBILE_STATION_PG_URL when MOBILE_STATION_REQUIRE_PG=1', () => {
      throw new Error('MOBILE_STATION_PG_URL is required');
    });
  });
}

d('new-chain reset against real PostgreSQL (all migrations applied)', () => {
  const dbName = `ncr_${process.pid}_${Date.now().toString(36)}`;
  let admin: Pool;
  let pool: Pool;
  const asDb = (p: Pool): ResetDb => ({
    query: async (t, params = []) => (await p.query(t, params as any[])).rows,
    begin: async (fn) => {
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        const out = await fn({ query: async (t, params = []) => (await c.query(t, params as any[])).rows });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
  });
  const n = async (sql: string) => Number((await pool.query(sql)).rows[0].n);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: u.toString(), max: 2 });
    const dir = path.join(__dirname, '../drizzle/migrations');
    for (const f of fs.readdirSync(dir).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort()) {
      await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    await pool.query(`
      INSERT INTO users (id, username, wallet_address) VALUES (1, 'synthetic', '0x${'aa'.repeat(20)}');
      INSERT INTO weather_stations (station_id, owner_address, location)
        VALUES ('st-1', '0x${'aa'.repeat(20)}', 'synthetic cell');
      INSERT INTO station_reward_cycles (cycle_id, station_id, owner_address, observation_id, observation_digest,
          observation_observed_at, observation_accepted_at)
        VALUES ('c-1', 'st-1', '0x${'aa'.repeat(20)}', 'o-1', 'dg', now(), now());
      INSERT INTO station_reward_cycle_events (cycle_id, event_type, to_state) VALUES ('c-1', 'created', 'VERIFYING');
      INSERT INTO mobile_station_nonces (nonce, owner_address, station_id, expires_at) VALUES ('n-1', '0x${'bb'.repeat(20)}', 'mob-1', 1);
      INSERT INTO contributor_rewards (user_id, contributor_type, amount, metadata)
        VALUES (1, 'achievement', 10, '{"payoutAuthorization":{"nonce":"${'ef'.repeat(32)}"}}'),
               (1, 'achievement', 5, '{}'),
               (1, 'forecast', 7, '{}');
      INSERT INTO operator_role_labels VALUES
        ('777', '${G_OLD}', 'producer', '${PRODUCER}', 1, NULL, 'N5 node', 'owner', now()),
        ('777', '${G_OLD}', 'attester', '${ATTESTER}', 1, 500, 'Mango', 'owner', now());
    `);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it('dry run changes nothing', async () => {
    const r = await runNewChainReset(asDb(pool), base);
    expect(r.tables.find(t => t.table === 'station_reward_cycles')!.rows).toBe(1);
    expect(r.tables.find(t => t.table === ACHIEVEMENT_LEDGER_TABLE)!.rows).toBe(2);
    expect(await n('SELECT count(*) AS n FROM pg_namespace WHERE nspname = \'chain_reset_777_test\'')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM station_reward_cycles')).toBe(1);
  });

  it('a failing step rolls the whole reset back', async () => {
    await pool.query('CREATE TABLE fk_guard (cycle_id text REFERENCES station_reward_cycles(cycle_id))');
    try {
      await expect(runNewChainReset(asDb(pool), { ...base, apply: true })).rejects.toThrow();
      expect(await n('SELECT count(*) AS n FROM pg_namespace WHERE nspname = \'chain_reset_777_test\'')).toBe(0);
      expect(await n('SELECT count(*) AS n FROM station_reward_cycles')).toBe(1);
      expect(await n('SELECT count(*) AS n FROM contributor_rewards WHERE contributor_type = \'achievement\'')).toBe(2);
    } finally {
      await pool.query('DROP TABLE fk_guard');
    }
  });

  it('apply archives, truncates, keeps other rewards and stations, and re-seeds open labels', async () => {
    const r = await runNewChainReset(asDb(pool), {
      ...base, apply: true, toGenesisHash: G_NEW, copyLabelsFromGenesisHash: G_OLD, labelApprovalReference: 'owner 10-22',
    });
    expect(r.labels).toEqual({ planned: 1, copied: 1, inserted: 1 });
    for (const t of RESET_TABLES) expect(await n(`SELECT count(*) AS n FROM public."${t}"`)).toBe(0);
    expect(await n('SELECT count(*) AS n FROM chain_reset_777_test.station_reward_cycles')).toBe(1);
    expect(await n('SELECT count(*) AS n FROM chain_reset_777_test.station_reward_cycle_events')).toBe(1);
    expect(await n('SELECT count(*) AS n FROM chain_reset_777_test.mobile_station_nonces')).toBe(1);
    expect(await n('SELECT count(*) AS n FROM chain_reset_777_test.contributor_rewards_achievement')).toBe(2);
    expect(await n('SELECT count(*) AS n FROM contributor_rewards')).toBe(1);
    expect(await n('SELECT count(*) AS n FROM weather_stations')).toBe(1);
    const labels = (await pool.query(`SELECT chain_id, genesis_hash, role, operator_identity, from_height, through_height, approval_reference
      FROM operator_role_labels WHERE chain_id = '888'`)).rows;
    expect(labels).toEqual([{ chain_id: '888', genesis_hash: G_NEW, role: 'producer', operator_identity: PRODUCER,
      from_height: '1', through_height: null, approval_reference: 'owner 10-22' }]);
    const manifest = (await pool.query('SELECT from_chain_id, to_chain_id, to_genesis_hash FROM chain_reset_777_test.reset_manifest')).rows;
    expect(manifest).toEqual([{ from_chain_id: '777', to_chain_id: '888', to_genesis_hash: G_NEW }]);
  });

  it('refuses to reuse an existing archive schema', async () => {
    await expect(runNewChainReset(asDb(pool), { ...base, apply: true })).rejects.toThrow('already exists');
  });
});
