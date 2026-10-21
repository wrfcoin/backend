/** Explicit opt-in entrypoint; the main API never starts this worker. */
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { StorageProvidersClient } from './services/storage-providers-client.js';
import { archiveReleasedDays, archiveWeatherDay } from './services/weather-ipfs-archive.js';

async function run(): Promise<void> {
  if (process.env.WRFCOIN_WEATHER_ARCHIVE_ENABLED !== 'true') {
    console.log(JSON.stringify({ weatherArchive: 'disabled' }));
    return;
  }
  const directory = process.env.WRFCOIN_WEATHER_ARCHIVE_DIR;
  if (!directory || !process.env.DATABASE_URL) throw new Error('Archive configuration unavailable');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000,
    options: '-c default_transaction_read_only=on',
  });
  const storage = new StorageProvidersClient();
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);
  try {
    const day = process.argv[2];
    if (day) {
      const receipt = await archiveWeatherDay(pool, storage, directory, day);
      console.log(JSON.stringify({ day: receipt.day, cid: receipt.cid, status: 'archived' }));
      return;
    }
    while (!stop.signal.aborted) {
      try {
        const results = await archiveReleasedDays(pool, storage, directory);
        console.log(JSON.stringify({ weatherArchive: results }));
      } catch { console.error(JSON.stringify({ weatherArchive: 'unavailable' })); }
      try { await delay(3_600_000, undefined, { signal: stop.signal }); }
      catch { if (!stop.signal.aborted) throw new Error('Archive timer unavailable'); }
    }
  } finally {
    process.removeListener('SIGTERM', onStop);
    process.removeListener('SIGINT', onStop);
    await pool.end();
  }
}

run().catch(() => {
  // Never print query errors, connection strings, payloads or upstream details.
  console.error(JSON.stringify({ weatherArchive: 'unavailable' }));
  process.exitCode = 1;
});
