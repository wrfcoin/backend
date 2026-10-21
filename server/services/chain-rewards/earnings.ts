import { aliasEpoch } from './payee-aliases.js';
import { profileKeyFor, shortAddress } from '../../utils/contributor-alias.js';
import type { Pool, Client } from './store.js';

export const ROLES = ['contribution', 'attester', 'producer', 'node', 'forecast'] as const;
export type Role = typeof ROLES[number];
export type Period = 'all' | '7d' | '30d';
export const earningsEnabled = () => process.env.CHAIN_REWARD_INDEX_ENABLED === 'true' && process.env.CHAIN_REWARD_EARNINGS_ENABLED === 'true';
export class EarningsUnavailable extends Error { constructor() { super('EARNINGS_UNAVAILABLE'); } }
export interface EarningsSource {
  leaderboard(role: Role, period: Period, limit: number): Promise<any>;
  profile(address: string): Promise<any>;
  addresses(): Promise<string[]>;
  resolveAddress?(keyOrAddress: string): Promise<string | null>;
}
const units = { currency: 'WRF', decimals: 8, scale: '100000000' };
function display(amount: string) {
  const n = BigInt(amount); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, '0')}`;
}
const unsupported = (role: Role) => ({ role, status: role === 'node' ? 'unsupported' : 'unavailable', complete: false,
  paidBaseUnits: null, message: role === 'node' ? 'Node payments are not implemented yet' : 'Paid-event coverage unavailable' });

export function createEarningsSource(pool: Pool, chain: string, genesis: string, clock = () => Date.now()): EarningsSource {
  const args = [chain, genesis];
  async function snapshot<T>(fn: (client: Client, header: any) => Promise<T>): Promise<T> {
    let client: Client | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = (await client.query(`SELECT s.*, to_char(b.block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS block_time FROM chain_reward_index_state s
        JOIN chain_reward_blocks b ON b.chain_id=s.chain_id AND b.genesis_hash=s.genesis_hash AND b.height=s.cursor_height AND b.block_hash=s.cursor_hash
        WHERE s.chain_id=$1 AND s.genesis_hash=$2`, args)).rows[0];
      const age = state ? clock() - new Date(state.checked_at).getTime() : NaN;
      if (!state || state.status !== 'ok' || state.reorg_probe_height !== null || state.parser_version !== 1 ||
          Number(state.history_floor) !== 1 || !Number.isFinite(age) || age < -5000 || age > 600000) throw new EarningsUnavailable();
      const coverage = (await client.query(`SELECT count(*)::text AS count, min(height)::text AS floor, max(height)::text AS ceiling,
        bool_and(parser_version=1) AS parsed FROM chain_reward_blocks WHERE chain_id=$1 AND genesis_hash=$2`, args)).rows[0];
      if (!coverage?.parsed || coverage.floor !== '1' || coverage.ceiling !== String(state.cursor_height) || coverage.count !== String(state.cursor_height)) throw new EarningsUnavailable();
      const header = { units, coverage: { fromHeight: '1', throughHeight: String(state.cursor_height), complete: true },
        asOf: { height: String(state.cursor_height), hash: state.cursor_hash, time: state.block_time, checkedAt: new Date(state.checked_at).toISOString() },
        finalityPolicy: 'confirmed-canonical-with-rollback' };
      const result = await fn(client, header); await client.query('COMMIT'); return result;
    } catch { if (client) { try { await client.query('ROLLBACK'); } catch {} } throw new EarningsUnavailable(); }
    finally { client?.release(); }
  }
  async function paid(client: Client, header: any, role: Role, period: Period, limit: number, address?: string) {
    const end = header.asOf.time;
    // Keep PostgreSQL microseconds at both inclusive boundaries; JS Date truncates them.
    const start = period === 'all' ? null : (await client.query(`SELECT to_char(
      ($1::timestamptz - $2::int * interval '24 hours') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start`, [end, period === '7d' ? 7 : 30])).rows[0].start;
    const result = await client.query(`SELECT p.payee_address, min(a.profile_key) AS profile_key, SUM(p.amount)::text AS amount,
      CASE WHEN count(*) FILTER (WHERE l.display_label IS NULL)=0 AND count(DISTINCT l.display_label)=1
        THEN min(l.display_label) ELSE NULL END AS label
      FROM chain_role_payouts p JOIN chain_reward_blocks b
        ON b.chain_id=p.chain_id AND b.genesis_hash=p.genesis_hash AND b.height=p.height AND b.block_hash=p.block_hash
      LEFT JOIN chain_role_payees a ON a.chain_id=p.chain_id AND a.genesis_hash=p.genesis_hash
        AND a.payee_address=p.payee_address AND a.alias_epoch=$8
      LEFT JOIN LATERAL (SELECT min(display_label) AS display_label FROM operator_role_labels l
        WHERE l.chain_id=p.chain_id AND l.genesis_hash=p.genesis_hash AND l.role=p.role AND l.operator_identity=p.operator_identity
          AND p.height>=l.from_height AND (l.through_height IS NULL OR p.height<=l.through_height)
        HAVING count(*)=1) l ON true
      WHERE p.chain_id=$1 AND p.genesis_hash=$2 AND p.role=$3
        AND ($5::timestamptz IS NULL OR (b.block_time<=$4::timestamptz AND b.block_time>=$5::timestamptz))
        AND ($6::text IS NULL OR p.payee_address=$6)
      GROUP BY p.payee_address HAVING SUM(p.amount)>0
      ORDER BY SUM(p.amount) DESC, p.payee_address ASC LIMIT $7`, [...args, role, end, start, address ?? null, limit, aliasEpoch()]);
    return { ...header, role, requestedScope: period, effectiveScope: period, status: 'available', complete: true,
      window: { from: start, through: end }, rows: result.rows.map((r, i) => {
        const key = profileKeyFor(r.payee_address); if (!key || r.profile_key !== key) throw new EarningsUnavailable();
        return { rank: i + 1, profileKey: key, shortAddress: shortAddress(r.payee_address),
          displayName: r.label ?? `Operator-${key.slice(2, 10)}`, paidBaseUnits: r.amount, paidDisplay: display(r.amount) };
      }) };
  }
  return {
    leaderboard: (role, period, limit) => {
      if (role !== 'producer' && role !== 'attester') return Promise.resolve({ units, ...unsupported(role), requestedScope: period, effectiveScope: null, coverage: null, asOf: null, finalityPolicy: null, rows: [] });
      return snapshot((client, header) => paid(client, header, role, period, limit));
    },
    profile: address => snapshot(async (client, header) => {
      // A legacy native-form identifier is not a verified mapping to an indexed payee.
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new EarningsUnavailable();
      const roles: any = {};
      for (const role of ROLES) {
        if (role === 'producer' || role === 'attester') {
          const result = await paid(client, header, role, 'all', 1, address.toLowerCase());
          const row = result.rows[0]; roles[role] = { role, status: 'available', complete: true, paidBaseUnits: row?.paidBaseUnits ?? '0', paidDisplay: row?.paidDisplay ?? '0.00000000', displayName: row?.displayName ?? null, coverage: header.coverage, asOf: header.asOf };
        } else roles[role] = unsupported(role);
      }
      return { ...header, roles, overallPaidBaseUnits: null, overallComplete: false };
    }),
    resolveAddress: async input => {
      let client: Client | undefined;
      try {
        client = await pool.connect();
        const byKey = /^c_[0-9a-f]{24}$/.test(input), epoch = aliasEpoch();
        if (byKey && !epoch) throw new EarningsUnavailable();
        if (!byKey && !/^0x[0-9a-fA-F]{40}$/.test(input)) return null;
        const rows = byKey
          ? (await client.query(`SELECT a.payee_address FROM chain_role_payees a
              WHERE a.chain_id=$1 AND a.genesis_hash=$2 AND a.alias_epoch=$3 AND a.profile_key=$4
                AND EXISTS (SELECT 1 FROM chain_role_payouts p WHERE p.chain_id=a.chain_id
                  AND p.genesis_hash=a.genesis_hash AND p.payee_address=a.payee_address) LIMIT 1`, [...args, epoch, input])).rows
          : (await client.query(`SELECT payee_address FROM chain_role_payouts
              WHERE chain_id=$1 AND genesis_hash=$2 AND payee_address=$3 LIMIT 1`, [...args, input.toLowerCase()])).rows;
        const address = rows[0]?.payee_address ?? null;
        return byKey && address && profileKeyFor(address) !== input ? null : address;
      } catch { throw new EarningsUnavailable(); } finally { client?.release(); }
    },
    addresses: async () => {
      let client: Client | undefined;
      try { client = await pool.connect(); return (await client.query('SELECT DISTINCT payee_address FROM chain_role_payouts WHERE chain_id=$1 AND genesis_hash=$2', args)).rows.map(r => r.payee_address); }
      catch { throw new EarningsUnavailable(); } finally { client?.release(); }
    },
  };
}
export function defaultEarningsSource(): EarningsSource {
  const source = async () => {
    const chain = process.env.CHAIN_REWARD_INDEX_CHAIN_ID, genesis = process.env.CHAIN_REWARD_INDEX_GENESIS_HASH;
    if (!chain || !/^[0-9]{1,20}$/.test(chain) || !genesis || !/^[0-9a-f]{64}$/.test(genesis)) throw new EarningsUnavailable();
    return createEarningsSource((await import('../../../database/db.js')).pool, chain, genesis);
  };
  return { leaderboard: async (...a) => (await source()).leaderboard(...a), profile: async a => (await source()).profile(a), addresses: async () => (await source()).addresses(), resolveAddress: async input => (await source()).resolveAddress!(input) };
}
