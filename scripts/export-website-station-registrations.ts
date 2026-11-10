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
 *   Optional: --confirmed-reporting <station id> (repeatable): the caller saw these stations reporting
 *     in a look just before this run. When ANY is given, NO provider read is made at all and only
 *     these ids are exported (every database rule still applies). The batch tool passes them on its
 *     second, stamped export, which runs inside the signing window and must take no time.
 *   Optional: --not-after <unix secs>: past that time no provider read is started and nothing is
 *     written (exit 1). The batch tool passes the time at which it stops waiting for the look.
 *
 * A look makes at most 3 provider reads per requested station (63 for a full batch of 21), oldest
 * first from a start that moves on every ten minutes; stations it does not reach are listed as
 * not_checked. A station with no bound device or no stored application key is listed as
 * credentials_incomplete and is never read. Redirects are refused (the keys are in the query
 * string) and at most 1 MB of a provider answer is read.
 *
 * Only stations that are ready are exported: proof stored, station active and still the signer's,
 * provider credentials stored with ingestion active, a neutral id, and REPORTING. Reporting is
 * settled here by a fresh provider read with the station's stored keys: a reading from the station's
 * own device (its MAC) in the last 24 hours. One request per station, at most one a second
 * (WEBSITE_STATION_PROVIDER_MIN_INTERVAL_MS, default and minimum 1000), 10 s timeout. A provider
 * error, timeout or 429 leaves the station waiting (provider_unreachable); it is never exported on
 * an error. Credentials and provider answers are never printed. Needs API_KEY_ENCRYPTION_KEY.
 * Waiting stations that are not exported are listed by id with the reason, and in the artifact's
 * `not_exported`; the artifact is written even when nothing is ready (exit 2).
 *   Optional: --cli-batch-out <file> --submitted-at <unix secs> ALSO writes the bare JSON array that
 *     `wrfcoin station build-registration --batch` accepts (submitted_at is the operator-supplied
 *     value; no clock is read).
 *
 * Exit codes: 0 = exported (skipped rows, if any, are listed); 2 = nothing to
 * export or every row skipped; 1 = usage/connection error.
 */
import { linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { resolveWebsiteStationChain } from '../server/services/website-station-chain-registration.js';
import {
  ambientProviderChecker,
  cappedProviderFetch,
  resolveProviderMinIntervalMs,
  runWebsiteExportCli,
  type ProviderChecker,
  type WebsiteExportPool,
} from '../server/services/website-station-export.js';
import { decryptData } from '../server/utils/crypto.js';

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
  // Whether a station is reporting is settled by a fresh provider read with its stored keys (the
  // read the collector makes). That needs API_KEY_ENCRYPTION_KEY, the key the backend stores
  // them under; without it no station can be shown to be reporting and none is exported.
  // Requests are paced: WEBSITE_STATION_PROVIDER_MIN_INTERVAL_MS, default and minimum 1000.
  const encryptionKey = process.env.API_KEY_ENCRYPTION_KEY ?? '';
  let providerCheck: ProviderChecker | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    providerCheck = ambientProviderChecker({
      // Redirects are refused and at most 1 MB of the answer is read (see cappedProviderFetch).
      fetchFn: cappedProviderFetch((url, init) => globalThis.fetch(url, init) as any),
      decrypt: (value) => decryptData(value, encryptionKey),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      minIntervalMs: resolveProviderMinIntervalMs(process.env.WEBSITE_STATION_PROVIDER_MIN_INTERVAL_MS),
    });
  } else {
    console.error('API_KEY_ENCRYPTION_KEY is not set or not 64 hex characters: no station can be checked with its provider');
  }
  try {
    return await runWebsiteExportCli(process.argv.slice(2), {
      pool,
      chain,
      providerCheck,
      // Whole file or no file, and never over an existing one: write a private temporary name
      // beside the target, link it into place (link fails if the target exists), drop the name.
      writeFile: (path, data) => {
        const partial = `${path}.${randomBytes(6).toString('hex')}.partial`;
        writeFileSync(partial, data, { flag: 'wx', mode: 0o600 });
        try {
          linkSync(partial, path);
        } finally {
          unlinkSync(partial);
        }
      },
      // The look starts from a station that moves on every ten minutes.
      rotation: Math.floor(Date.now() / 600_000),
      log: (m) => console.log(m),
      error: (m) => console.error(m),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
