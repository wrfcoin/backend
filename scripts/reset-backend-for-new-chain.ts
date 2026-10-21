/**
 * Owner-run backend reset for a new chain (genesis 888). Logic and the full
 * table list live in server/services/new-chain-reset.ts; the runbook is
 * docs/operations/new-chain-backend-reset.md.
 *
 * DRY RUN by default: prints row counts only and changes nothing.
 * --apply archives the rows into a new schema, then truncates, in one
 * transaction. Stop the backend first.
 *
 * Usage:
 *   npx tsx scripts/reset-backend-for-new-chain.ts --from-chain-id 777 --to-chain-id 888
 *   npx tsx scripts/reset-backend-for-new-chain.ts --from-chain-id 777 --to-chain-id 888 \
 *     --to-genesis-hash <64 hex> --copy-labels-from-genesis <old 64 hex> \
 *     --label-approval-reference "<owner approval>" --apply
 *   Optional: --archive-schema <name> (default chain_reset_<from>_<UTC yyyymmddhhmm>)
 *             --labels-file <json array of {role, operator_identity, display_label}>
 *
 * Environment:
 *   DATABASE_URL                       postgres connection string (never printed)
 *   CHAIN_REWARD_INDEX_CHAIN_ID        checked against --to-chain-id (match/mismatch only)
 *   CHAIN_REWARD_INDEX_GENESIS_HASH    checked against --to-genesis-hash
 *
 * Exit codes: 0 = done; 1 = usage, connection or database error (rolled back).
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import {
  formatReport,
  parseArgs,
  parseLabels,
  ResetUsageError,
  runNewChainReset,
  type ResetDb,
} from '../server/services/new-chain-reset.js';

async function main(): Promise<number> {
  let options;
  try {
    const parsed = parseArgs(process.argv.slice(2), new Date());
    const { labelsFile, ...rest } = parsed;
    options = {
      ...rest,
      labels: labelsFile ? parseLabels(JSON.parse(readFileSync(labelsFile, 'utf8'))) : undefined,
      rewardIndexEnv: {
        chainId: process.env.CHAIN_REWARD_INDEX_CHAIN_ID?.trim() || undefined,
        genesisHash: process.env.CHAIN_REWARD_INDEX_GENESIS_HASH?.trim() || undefined,
      },
    };
  } catch (error) {
    console.error(error instanceof ResetUsageError || error instanceof SyntaxError ? error.message : 'invalid arguments');
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    return 1;
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const wrap = (q: { unsafe: (t: string, p?: any[]) => Promise<any> }) => ({
    query: async (text: string, params: unknown[] = []) => [...(await q.unsafe(text, params as any[]))],
  });
  const db: ResetDb = {
    ...wrap(sql),
    // postgres.js refuses a bare BEGIN through unsafe(); begin() reserves one session.
    begin: (fn) => sql.begin((tx) => fn(wrap(tx as any))) as any,
  };
  try {
    const report = await runNewChainReset(db, options);
    console.log(formatReport(report));
    return 0;
  } catch (error) {
    if (error instanceof ResetUsageError) console.error(error.message);
    else console.error(`reset failed and was rolled back: ${(error as { code?: string })?.code ?? 'database error'}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
