/**
 * Backend reset for a new chain (genesis 888, Refs backend#1504 / core4#3592).
 *
 * The testnet restarts as a new chain with zero balances. Backend rows that
 * describe the OLD chain's state would otherwise be served (or replayed) as if
 * they belonged to the new one: per-phone station registrations, station
 * reward cycles, oracle work items, achievement payout reservations, weather
 * commitments and the chain block/tx caches.
 *
 * What it does, in ONE transaction:
 *   1. copies every affected row into a fresh archive schema
 *      (`CREATE TABLE <archive>.<table> AS SELECT ...`), so nothing is lost;
 *   2. TRUNCATEs the reset tables in one statement (no CASCADE: a foreign key
 *      from an unlisted table makes it fail instead of silently emptying more);
 *   3. DELETEs the achievement payout ledger rows (contributor_rewards with
 *      contributor_type = 'achievement'); other contributor rewards are kept;
 *   4. optionally re-seeds operator_role_labels for the new (chain_id,
 *      genesis_hash), from an owner-approved list and/or by copying the open
 *      label rows of the old chain.
 *
 * Not touched: the chain reward index tables (chain_reward_index_state,
 * chain_reward_blocks, chain_role_payouts, chain_role_payees) are keyed by
 * (chain_id, genesis_hash), so the new chain gets its own rows as soon as
 * CHAIN_REWARD_INDEX_CHAIN_ID / CHAIN_REWARD_INDEX_GENESIS_HASH name it.
 * Users, wallets, weather_stations and weather observations are kept.
 *
 * Dry run is the default and only reads row counts.
 */

export interface ResetQuery {
  query(text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}
export interface ResetDb extends ResetQuery {
  /** Runs fn inside one database transaction; rolls back if it throws. */
  begin<T>(fn: (tx: ResetQuery) => Promise<T>): Promise<T>;
}

/** Truncated together, in this order of listing; FK children precede parents. */
export const RESET_TABLES = Object.freeze([
  'mobile_station_nonces',
  'mobile_station_registrations',
  'oracle_work_claim_results',
  'oracle_work_items',
  'station_reward_cycle_events',
  'station_reward_cycles',
  'weather_commitments',
  'transactions',
  'blocks',
] as const);

export const ACHIEVEMENT_LEDGER_TABLE = 'contributor_rewards';
export const ACHIEVEMENT_LEDGER_PREDICATE = 'contributor_type = \'achievement\'';

export const LABEL_ROLES = ['producer', 'attester'] as const;
/** Mirrors the operator_role_labels CHECK in drizzle/migrations/0032. */
export const LABEL_DISPLAY_VALUES = ['N5 node', 'Mango', 'Workstation'] as const;

export interface LabelRow {
  role: (typeof LABEL_ROLES)[number];
  operator_identity: string;
  display_label: (typeof LABEL_DISPLAY_VALUES)[number];
}

export interface ResetOptions {
  apply: boolean;
  /** Old chain, used only to name the archive and to copy labels. */
  fromChainId: string;
  /** New chain. */
  toChainId: string;
  /** New chain's genesis hash, 64 lowercase hex. Required for label work. */
  toGenesisHash?: string;
  archiveSchema: string;
  /** Owner-approved new-chain labels. */
  labels?: LabelRow[];
  /** Copy the open (through_height IS NULL) label rows of this old genesis. */
  copyLabelsFromGenesisHash?: string;
  labelApprovalReference?: string;
  /** The reward-index env the backend will run with (checked, never changed). */
  rewardIndexEnv?: { chainId?: string; genesisHash?: string };
}

export interface ResetReport {
  mode: 'dry-run' | 'applied';
  archiveSchema: string;
  tables: Array<{ table: string; rows: number | null; action: 'truncate' | 'delete-achievement-rows' }>;
  labels: { planned: number; copied: number | null; inserted: number | null };
  rewardIndexEnv: 'match' | 'mismatch' | 'unset';
  warnings: string[];
}

export class ResetUsageError extends Error {}

const CHAIN_ID = /^[0-9]{1,20}$/;
const HASH = /^[0-9a-f]{64}$/;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
const IDENTITY = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;

/** Default archive schema: chain_reset_<from>_<UTC yyyymmddhhmm>. */
export function defaultArchiveSchema(fromChainId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `chain_reset_${fromChainId}_${stamp}`;
}

/** Same canonical form migration 0033 enforces. */
export function canonicalIdentity(raw: string): string {
  const v = String(raw).trim();
  if (/^[0-9a-fA-F]{40}$/.test(v)) return `0x${v.toLowerCase()}`;
  return v.toLowerCase();
}

export function parseLabels(raw: unknown): LabelRow[] {
  if (!Array.isArray(raw)) throw new ResetUsageError('labels file must hold a JSON array');
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const role = e?.role;
    const identity = typeof e?.operator_identity === 'string' ? canonicalIdentity(e.operator_identity) : '';
    const label = e?.display_label;
    if (!LABEL_ROLES.includes(role as never)) throw new ResetUsageError(`labels[${i}]: role must be producer or attester`);
    if (!IDENTITY.test(identity)) throw new ResetUsageError(`labels[${i}]: operator_identity is not a 64-hex key or 40-hex address`);
    if (role === 'producer' && !/^[0-9a-f]{64}$/.test(identity)) {
      throw new ResetUsageError(`labels[${i}]: a producer identity must be a 64-hex key`);
    }
    if (!LABEL_DISPLAY_VALUES.includes(label as never)) {
      throw new ResetUsageError(`labels[${i}]: display_label must be one of ${LABEL_DISPLAY_VALUES.join(', ')}`);
    }
    return { role: role as LabelRow['role'], operator_identity: identity, display_label: label as LabelRow['display_label'] };
  });
}

export function validateOptions(o: ResetOptions): void {
  if (!CHAIN_ID.test(o.fromChainId)) throw new ResetUsageError('--from-chain-id must be a decimal chain id');
  if (!CHAIN_ID.test(o.toChainId)) throw new ResetUsageError('--to-chain-id must be a decimal chain id');
  if (o.fromChainId === o.toChainId) throw new ResetUsageError('--from-chain-id and --to-chain-id must differ');
  if (!SCHEMA.test(o.archiveSchema) || o.archiveSchema === 'public' || o.archiveSchema.startsWith('pg_')) {
    throw new ResetUsageError('--archive-schema must be a new lowercase identifier');
  }
  if (o.toGenesisHash !== undefined && !HASH.test(o.toGenesisHash)) {
    throw new ResetUsageError('--to-genesis-hash must be 64 lowercase hex characters');
  }
  if (o.copyLabelsFromGenesisHash !== undefined && !HASH.test(o.copyLabelsFromGenesisHash)) {
    throw new ResetUsageError('--copy-labels-from-genesis must be 64 lowercase hex characters');
  }
  const labelWork = (o.labels?.length ?? 0) > 0 || o.copyLabelsFromGenesisHash !== undefined;
  if (labelWork) {
    if (!o.toGenesisHash) throw new ResetUsageError('label re-seeding needs --to-genesis-hash (fill it after the cut)');
    if (!o.labelApprovalReference || !o.labelApprovalReference.trim()) {
      throw new ResetUsageError('label re-seeding needs --label-approval-reference');
    }
  }
}

function rewardIndexStatus(o: ResetOptions): ResetReport['rewardIndexEnv'] {
  const env = o.rewardIndexEnv;
  if (!env?.chainId && !env?.genesisHash) return 'unset';
  const chainOk = env.chainId === o.toChainId;
  const genesisOk = o.toGenesisHash ? env.genesisHash === o.toGenesisHash : Boolean(env.genesisHash);
  return chainOk && genesisOk ? 'match' : 'mismatch';
}

async function tableExists(db: ResetQuery, table: string): Promise<boolean> {
  const rows = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]);
  return rows[0]?.present === true;
}

async function count(db: ResetQuery, table: string, where?: string): Promise<number> {
  const rows = await db.query(`SELECT count(*)::text AS n FROM public."${table}"${where ? ` WHERE ${where}` : ''}`);
  return Number(rows[0]?.n ?? 0);
}

/** Owner-approved list first, then copied rows that the list does not already name. */
async function plannedLabels(db: ResetQuery, o: ResetOptions): Promise<{ rows: LabelRow[]; copied: number }> {
  const rows: LabelRow[] = [...(o.labels ?? [])];
  let copied = 0;
  if (o.copyLabelsFromGenesisHash) {
    const old = await db.query(
      `SELECT role, operator_identity, display_label FROM public.operator_role_labels
        WHERE chain_id = $1 AND genesis_hash = $2 AND through_height IS NULL
        ORDER BY role, operator_identity`,
      [o.fromChainId, o.copyLabelsFromGenesisHash],
    );
    for (const r of old) {
      const row = { role: r.role, operator_identity: r.operator_identity, display_label: r.display_label } as LabelRow;
      if (!rows.some(x => x.role === row.role && x.operator_identity === row.operator_identity)) {
        rows.push(row);
        copied += 1;
      }
    }
  }
  return { rows, copied };
}

export async function runNewChainReset(db: ResetDb, o: ResetOptions): Promise<ResetReport> {
  validateOptions(o);
  const warnings: string[] = [];
  const env = rewardIndexStatus(o);
  if (env === 'mismatch') {
    warnings.push(`CHAIN_REWARD_INDEX_CHAIN_ID/_GENESIS_HASH do not name chain ${o.toChainId}${o.toGenesisHash ? ' and the given genesis' : ''}`);
  } else if (env === 'unset') {
    warnings.push('CHAIN_REWARD_INDEX_CHAIN_ID/_GENESIS_HASH are not set in this shell; set them on the backend before restart');
  }

  const present: string[] = [];
  for (const t of RESET_TABLES) {
    if (await tableExists(db, t)) present.push(t);
    else warnings.push(`table ${t} does not exist; skipped`);
  }
  const ledgerPresent = await tableExists(db, ACHIEVEMENT_LEDGER_TABLE);
  if (!ledgerPresent) warnings.push(`table ${ACHIEVEMENT_LEDGER_TABLE} does not exist; skipped`);

  const work = async (tx: ResetQuery, apply: boolean): Promise<ResetReport> => {
    // Fail fast instead of queueing behind a live backend's locks.
    if (apply) await tx.query('SET LOCAL lock_timeout = \'5s\'');
    const tables: ResetReport['tables'] = [];
    for (const t of RESET_TABLES) {
      tables.push({ table: t, rows: present.includes(t) ? await count(tx, t) : null, action: 'truncate' });
    }
    tables.push({
      table: ACHIEVEMENT_LEDGER_TABLE,
      rows: ledgerPresent ? await count(tx, ACHIEVEMENT_LEDGER_TABLE, ACHIEVEMENT_LEDGER_PREDICATE) : null,
      action: 'delete-achievement-rows',
    });
    const labelPlan = (o.labels?.length || o.copyLabelsFromGenesisHash) ? await plannedLabels(tx, o) : { rows: [], copied: 0 };
    if (!apply) {
      return {
        mode: 'dry-run', archiveSchema: o.archiveSchema, tables,
        labels: { planned: labelPlan.rows.length, copied: o.copyLabelsFromGenesisHash ? labelPlan.copied : null, inserted: null },
        rewardIndexEnv: env, warnings,
      };
    }

    const exists = await tx.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [o.archiveSchema]);
    if (exists.length) throw new ResetUsageError(`archive schema ${o.archiveSchema} already exists; choose a new one`);
    await tx.query(`CREATE SCHEMA "${o.archiveSchema}"`);
    for (const t of present) {
      await tx.query(`CREATE TABLE "${o.archiveSchema}"."${t}" AS SELECT * FROM public."${t}"`);
    }
    if (ledgerPresent) {
      await tx.query(
        `CREATE TABLE "${o.archiveSchema}"."${ACHIEVEMENT_LEDGER_TABLE}_achievement" AS
           SELECT * FROM public."${ACHIEVEMENT_LEDGER_TABLE}" WHERE ${ACHIEVEMENT_LEDGER_PREDICATE}`,
      );
    }
    await tx.query(
      `CREATE TABLE "${o.archiveSchema}"."reset_manifest" (
         from_chain_id text NOT NULL, to_chain_id text NOT NULL, to_genesis_hash text,
         reset_at timestamptz NOT NULL DEFAULT now())`,
    );
    await tx.query(
      `INSERT INTO "${o.archiveSchema}"."reset_manifest" (from_chain_id, to_chain_id, to_genesis_hash)
       VALUES ($1, $2, $3)`,
      [o.fromChainId, o.toChainId, o.toGenesisHash ?? null],
    );
    if (present.length) {
      await tx.query(`TRUNCATE TABLE ${present.map(t => `public."${t}"`).join(', ')}`);
    }
    if (ledgerPresent) {
      await tx.query(`DELETE FROM public."${ACHIEVEMENT_LEDGER_TABLE}" WHERE ${ACHIEVEMENT_LEDGER_PREDICATE}`);
    }
    let inserted = 0;
    for (const l of labelPlan.rows) {
      const r = await tx.query(
        `INSERT INTO public.operator_role_labels
           (chain_id, genesis_hash, role, operator_identity, from_height, through_height,
            display_label, approval_reference, approved_at)
         VALUES ($1, $2, $3, $4, 1, NULL, $5, $6, now())
         ON CONFLICT DO NOTHING
         RETURNING 1 AS ok`,
        [o.toChainId, o.toGenesisHash, l.role, l.operator_identity, l.display_label, o.labelApprovalReference!.trim()],
      );
      inserted += r.length;
    }
    return {
      mode: 'applied', archiveSchema: o.archiveSchema, tables,
      labels: { planned: labelPlan.rows.length, copied: o.copyLabelsFromGenesisHash ? labelPlan.copied : null, inserted },
      rewardIndexEnv: env, warnings,
    };
  };

  return o.apply ? db.begin(tx => work(tx, true)) : work(db, false);
}

/** Counts and identifiers only: never a row's content. */
export function formatReport(r: ResetReport): string {
  const lines = [
    `mode: ${r.mode}`,
    `archive schema: ${r.archiveSchema}${r.mode === 'dry-run' ? ' (not created in dry run)' : ''}`,
  ];
  for (const t of r.tables) {
    const verb = t.action === 'truncate' ? 'truncate' : 'delete rows WHERE contributor_type = \'achievement\'';
    lines.push(`  ${t.table}: ${t.rows === null ? 'absent' : `${t.rows} rows`} -> ${verb}`);
  }
  lines.push(
    `operator_role_labels for the new chain: ${r.labels.planned} planned` +
      (r.labels.copied === null ? '' : ` (${r.labels.copied} copied from the old chain)`) +
      (r.labels.inserted === null ? '' : `, ${r.labels.inserted} inserted`),
  );
  lines.push(`reward index env: ${r.rewardIndexEnv}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

export function parseArgs(argv: string[], now: Date): ResetOptions & { labelsFile?: string } {
  const o: Partial<ResetOptions> & { labelsFile?: string } = { apply: false };
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ResetUsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
    case '--apply': o.apply = true; break;
    case '--dry-run': o.apply = false; break;
    case '--from-chain-id': o.fromChainId = need(i, a); i += 1; break;
    case '--to-chain-id': o.toChainId = need(i, a); i += 1; break;
    case '--to-genesis-hash': o.toGenesisHash = need(i, a); i += 1; break;
    case '--archive-schema': o.archiveSchema = need(i, a); i += 1; break;
    case '--labels-file': o.labelsFile = need(i, a); i += 1; break;
    case '--copy-labels-from-genesis': o.copyLabelsFromGenesisHash = need(i, a); i += 1; break;
    case '--label-approval-reference': o.labelApprovalReference = need(i, a); i += 1; break;
    default: throw new ResetUsageError(`unknown argument ${a}`);
    }
  }
  if (!o.fromChainId) throw new ResetUsageError('--from-chain-id is required');
  if (!o.toChainId) throw new ResetUsageError('--to-chain-id is required');
  o.archiveSchema ??= defaultArchiveSchema(o.fromChainId, now);
  return o as ResetOptions & { labelsFile?: string };
}
