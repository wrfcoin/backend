import { READ_PACE_MS, RUN_INTERVAL_MS, passDelayMs } from './scheduling.js';
import { refreshPayeeAliases, writePayeeAlias } from './payee-aliases.js';
import { PARSER_VERSION, RewardIndexError, type RewardBlock } from './parser.js';

export interface Client {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  release(): void;
}
export interface Pool { connect(): Promise<Client> }
export interface IndexState { height: number; hash: string | null; ready: boolean; probe: number | null; nextDelayMs?: number }
export interface IndexStore {
  state(): Promise<IndexState>;
  block(height: number): Promise<{ hash: string } | null>;
  beginPass(): Promise<void>;
  finishPass(status: string, lag: number | null): Promise<number>;
  reserveRead(): Promise<void>;
  probe(height: number | null): Promise<void>;
  rewind(height: number, hash: string | null): Promise<void>;
  append(block: RewardBlock): Promise<void>;
  status(status: string): Promise<void>;
}

/** Called only under the chain/genesis session advisory lock. DB time and the
 * persisted last reservation prevent a new pass/process from resetting pacing.
 */
export async function reservePacedRead(client: Client, args: string[],
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<void> {
  // The same session lock protects pacing across passes and process restarts.
  // Recheck after sleep: early timers cannot admit a request before its deadline.
  for (;;) {
    const row = (await client.query(`SELECT CASE WHEN last_read_at IS NULL THEN 0 ELSE
      GREATEST(0,ceil(extract(epoch FROM (last_read_at+$3*interval '1 millisecond'-clock_timestamp()))*1000)) END AS delay_ms
      FROM chain_reward_index_state WHERE chain_id=$1 AND genesis_hash=$2`, [...args, READ_PACE_MS])).rows[0];
    const delay = Number(row.delay_ms);
    if (delay <= 0) break;
    await sleep(delay);
  }
  await client.query(`UPDATE chain_reward_index_state SET last_read_at=clock_timestamp()
    WHERE chain_id=$1 AND genesis_hash=$2`, args);
}

/** A dedicated connection holds a session advisory lock throughout network reads.
 * Every receipt/cursor mutation uses a transaction on that same connection.
 */
export async function withRewardStore<T>(pool: Pool, chainId: string, genesis: string, fn: (store: IndexStore) => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  const args = [chainId, genesis];
  const lock = `chain-role-rewards:${chainId}:${genesis}`;
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock])).rows[0]?.locked === true;
    if (!locked) return null;
    await client.query('INSERT INTO chain_reward_index_state(chain_id,genesis_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING', args);
    const transaction = async (fn: () => Promise<void>) => {
      await client.query('BEGIN');
      try { await fn(); await client.query('COMMIT'); }
      catch { await client.query('ROLLBACK'); throw new RewardIndexError('DB_ERROR'); }
    };
    let startedAt = 0;
    const store: IndexStore = {
      async state() {
        const row = (await client.query('SELECT cursor_height,cursor_hash,reorg_probe_height,parser_version,next_run_at <= clock_timestamp() AS ready, CASE WHEN next_run_at <= clock_timestamp() THEN 0 ELSE GREATEST(0,ceil(extract(epoch FROM (next_run_at-clock_timestamp()))*1000)) END AS delay_ms FROM chain_reward_index_state WHERE chain_id=$1 AND genesis_hash=$2', args)).rows[0];
        const h = Number(row.cursor_height);
        if (Number(row.parser_version) !== PARSER_VERSION || !Number.isSafeInteger(h)) throw new RewardIndexError('DB_ERROR');
        return { height: h, hash: row.cursor_hash, ready: row.ready, probe: row.reorg_probe_height === null ? null : Number(row.reorg_probe_height), nextDelayMs: Number(row.delay_ms) };
      },
      async block(height) {
        const r = (await client.query('SELECT block_hash AS hash FROM chain_reward_blocks WHERE chain_id=$1 AND genesis_hash=$2 AND height=$3', [...args, height])).rows[0];
        return r ?? null;
      },
      async beginPass() {
        // Reserve crash/restart cooldown ONCE, anchored to this pass's start.
        const row = (await client.query(`UPDATE chain_reward_index_state
          SET next_run_at=clock_timestamp()+$3*interval '1 millisecond'
          WHERE chain_id=$1 AND genesis_hash=$2 RETURNING
          extract(epoch FROM (next_run_at-$3*interval '1 millisecond'))*1000 AS started_at`, [...args, RUN_INTERVAL_MS])).rows[0];
        startedAt = Number(row.started_at);
      },
      async finishPass(status, lag) {
        const row = (await client.query(`UPDATE chain_reward_index_state
          SET failure_count=CASE WHEN $3 IN ('ok','budget') THEN 0 ELSE LEAST(5,failure_count+1) END,
            status=$3,checked_at=clock_timestamp()
          WHERE chain_id=$1 AND genesis_hash=$2 RETURNING failure_count,
            extract(epoch FROM clock_timestamp())*1000 AS now_ms`, [...args, status])).rows[0];
        const delay = passDelayMs(status, lag, Number(row.failure_count), startedAt, Number(row.now_ms));
        await client.query(`UPDATE chain_reward_index_state
          SET next_run_at=clock_timestamp()+$3*interval '1 millisecond'
          WHERE chain_id=$1 AND genesis_hash=$2`, [...args, delay]);
        return delay;
      },
      async reserveRead() {
        await reservePacedRead(client, args);
      },
      async probe(height) { await client.query('UPDATE chain_reward_index_state SET reorg_probe_height=$3 WHERE chain_id=$1 AND genesis_hash=$2', [...args, height]); },
      async rewind(height, hash) {
        await transaction(async () => {
          await client.query('DELETE FROM chain_reward_blocks WHERE chain_id=$1 AND genesis_hash=$2 AND height>$3', [...args, height]);
          await client.query('UPDATE chain_reward_index_state SET cursor_height=$3,cursor_hash=$4,reorg_probe_height=NULL WHERE chain_id=$1 AND genesis_hash=$2', [...args, height, hash]);
        });
      },
      async append(block) {
        await transaction(async () => {
          const state = await store.state();
          if (block.height !== state.height + 1 || (state.hash !== null && block.prevHash !== state.hash)) throw new RewardIndexError('INVALID_BLOCK');
          await client.query('INSERT INTO chain_reward_blocks(chain_id,genesis_hash,height,block_hash,prev_hash,block_time,parser_version) VALUES ($1,$2,$3,$4,$5,$6,$7)', [...args, block.height, block.hash, block.prevHash, block.timestamp, PARSER_VERSION]);
          for (const p of block.payouts) {
            await client.query('INSERT INTO chain_role_payouts(chain_id,genesis_hash,height,block_hash,role,event_id,payee_address,operator_identity,amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [...args, block.height, block.hash, p.role, p.eventId, p.payee, p.identity, p.amount]);
          }
          for (const payee of new Set(block.payouts.map(p => p.payee))) await writePayeeAlias(client, args, payee);
          await client.query('UPDATE chain_reward_index_state SET cursor_height=$3,cursor_hash=$4,checked_at=now() WHERE chain_id=$1 AND genesis_hash=$2', [...args, block.height, block.hash]);
        });
      },
      async status(status) { await client.query('UPDATE chain_reward_index_state SET status=$3,checked_at=now() WHERE chain_id=$1 AND genesis_hash=$2', [...args, status]); },
    };
    await transaction(async () => { await refreshPayeeAliases(client, args); });
    return await fn(store);
  } catch { throw new RewardIndexError('DB_ERROR'); }
  finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]); }
    finally { client.release(); }
  }
}
