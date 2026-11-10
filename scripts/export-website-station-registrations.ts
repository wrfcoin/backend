/**
 * Export website stations that are waiting for their on-chain registration, for
 * the owner's registration batch.
 *
 * Reads website_station_chain_registrations WHERE status = 'db_only' (joined to
 * weather_stations for the position) and writes a
 * `website_station_registration_export_v1` JSON file. Each `stations[]` entry has
 * station_id, owner_address, owner_pubkey, owner_signature (the owner's signature
 * over core4's `station_ownership_message`), latitude/longitude at 0.1 degree,
 * hardware_model `personal-weather-station`, data_quality_tier `unverified`,
 * provenance_class `real`, chain_id and network_id. Each row is re-verified
 * first; failures are skipped and listed by station id only.
 *
 * NO governance key is read, held or needed here. Signing is the owner's step.
 *
 * It never changes a row and has no flag that does. A station leaves the waiting
 * list only when the chain station sync sees it registered on chain, so a second
 * run exports the same rows until then.
 *
 * The output holds station positions (0.1 degree) and owner proofs: never commit
 * a real one. Files are created 0600 and never overwritten.
 *
 * Environment:
 *   DATABASE_URL          postgres connection string
 *   WRFCOIN_CHAIN_ID      required, no default (the chain the owners signed for)
 *   WRFCOIN_NETWORK_ID    required, no default
 *
 * Usage:
 *   npx tsx scripts/export-website-station-registrations.ts --out /path/batch.json --batch-id <id>
 *   Optional: --limit <n> (default and maximum 21).
 *   Optional: --allow-id <station id> (repeatable): also export this station although its id is
 *     not a neutral server-issued id (`pws-` + 16 hex). Older ids hold the name the owner typed and
 *     a station id is public on chain for good, so each one is the operator's deliberate choice.
 *
 *   Optional: --confirmed-reporting <station id> (repeatable): the caller saw this station reporting
 *     in a look just before this run; make no node read for it. The batch tool passes these on its
 *     second, stamped export so that one stays quick.
 *
 * Only stations that are ready are exported: proof stored, station active and still the signer's,
 * provider credentials stored with ingestion active, and reporting. "Reporting" is a reading in
 * weather_data in the last 24 hours OR a reading in the node's chain tail (provider collectors submit
 * to the node, not to this backend). The node is asked only for stations the database has nothing
 * for, at about 20 calls a minute, so a run with many such stations takes minutes; it stops asking on
 * a 429. A node read that fails never exports a station. Each row's evidence names the source (db,
 * chain or confirmed).
 *   Also needs, for the chain look: the backend's node URL and WRFCOIN_READER_TOKEN.
 * Waiting stations that are not exported are listed by id with the reason, and in the artifact's
 * `not_exported`.
 *   Optional: --cli-batch-out <file> --submitted-at <unix secs> ALSO writes the bare JSON array that
 *     `wrfcoin station build-registration --batch` accepts (submitted_at is the operator-supplied
 *     value; no clock is read).
 *
 * Exit codes: 0 = exported (skipped rows, if any, are listed); 2 = nothing to
 * export or every row skipped; 1 = usage/connection error.
 */
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { resolveWebsiteStationChain } from '../server/services/website-station-chain-registration.js';
import {
  chainTailEvidence,
  runWebsiteExportCli,
  type WebsiteExportPool,
} from '../server/services/website-station-export.js';
import { createChainTailReader, type Core4Fetch } from '../server/services/chain-station-tail.js';
import { fetchCore4Json } from '../shared/core4-route-client.js';

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    return 1;
  }
  // No default chain: an unset WRFCOIN_CHAIN_ID / WRFCOIN_NETWORK_ID makes the export refuse to run.
  const chain = resolveWebsiteStationChain();
  const sql = postgres(databaseUrl, { max: 1 });
  const pool: WebsiteExportPool = {
    query: async (text, params = []) => {
      const rows = await sql.unsafe(text, params as any[]);
      return { rows: rows as unknown as any[], rowCount: (rows as any).count ?? rows.length };
    },
  };
  // Readings for a station the database has none for are looked up in the node's chain tail
  // (provider collectors submit to the node, not to this backend), with the same reader the
  // station pages use. Needs the node URL and WRFCOIN_READER_TOKEN from the backend's own
  // environment; without them every such station is reported as "could not check". Node calls
  // are counted and paced at about 20 a minute.
  let nodeCalls = 0;
  const countedFetch: Core4Fetch = (path, options) => {
    nodeCalls += 1;
    return (fetchCore4Json as Core4Fetch)(path, options);
  };
  const tail = createChainTailReader({ fetchCore4Json: countedFetch });
  const chainEvidence = chainTailEvidence({
    latest: (stationId) => tail.latest(stationId),
    takeCallCount: () => {
      const n = nodeCalls;
      nodeCalls = 0;
      return n;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  try {
    return await runWebsiteExportCli(process.argv.slice(2), {
      pool,
      chain,
      chainEvidence,
      writeFile: (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
      log: (m) => console.log(m),
      error: (m) => console.error(m),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
