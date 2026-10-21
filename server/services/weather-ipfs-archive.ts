/** Archive existing public daily releases only; never query raw observations. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PUBLISH_GRACE_SECONDS, MIN_TEMPERATURE_C, MAX_TEMPERATURE_C } from './temperature-history.js';

export interface ReleaseSource {
  query(sql: string, parameters: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface IpfsSink {
  storeIpfs(bytes: Buffer, contentType: string, tags: Record<string, string>): Promise<{
    content_id: { provider: string; hash: string }; provider: string; size: number; timestamp: number;
  }>;
}
export interface ArchiveReceipt {
  day: string;
  cid: string;
  sha256: string;
  bytes: number;
  cellCount: number;
  archivedAt: string;
}

const MAX_CELLS = 100_000;
// Base64 JSON must fit the daemon's default 2 MiB Axum request limit.
const MAX_BYTES = 1024 * 1024;
const SCHEMA = 'weather-temperature-daily/v1';
const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,126})$/;
export const ARCHIVE_RELEASE_SQL = `
  SELECT lat_e1, lon_e1, min_c, max_c, mean_c, count_bucket
  FROM weather_temperature_daily_release
  WHERE day = $1::date
  ORDER BY lat_e1, lon_e1
  LIMIT ${MAX_CELLS + 1}`;

export function eligibleDayBoundary(now: Date): string {
  return new Date(now.getTime() - PUBLISH_GRACE_SECONDS * 1000).toISOString().slice(0, 10);
}

function validDay(day: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day && day < eligibleDayBoundary(now);
}

function cell(row: Record<string, unknown>) {
  // Strict allowlist; fine coordinates and contributor metadata cannot escape.
  const latE1 = row.lat_e1, lonE1 = row.lon_e1;
  if (typeof latE1 !== 'number' || typeof lonE1 !== 'number' ||
      !Number.isInteger(latE1) || !Number.isInteger(lonE1) ||
      Math.abs(latE1) > 900 || Math.abs(lonE1) > 1800) throw new Error('Invalid daily release');
  const keys = ['min_c', 'max_c', 'mean_c', 'count_bucket'];
  const suppressed = keys.every(key => row[key] === null);
  // A suppressed cell must remain indistinguishable from an absent cell.
  if (suppressed) return undefined;
  if (keys.some(key => typeof row[key] !== 'number' &&
      !(typeof row[key] === 'string' && /^-?\d+(?:\.\d+)?$/.test(row[key] as string)))) {
    throw new Error('Invalid daily release');
  }
  const [minC, maxC, meanC, countBucket] = keys.map(key => Number(row[key]));
  if ([minC, maxC, meanC].some(value => !Number.isFinite(value) ||
      value < MIN_TEMPERATURE_C || value > MAX_TEMPERATURE_C || !Number.isInteger(value * 2)) ||
      minC > meanC || meanC > maxC || !Number.isSafeInteger(countBucket) || countBucket < 0 || countBucket % 10 !== 0) {
    throw new Error('Invalid daily release');
  }
  return { latE1, lonE1, minC, maxC, meanC, countBucket };
}

async function readReceipt(filename: string, day: string): Promise<ArchiveReceipt | undefined> {
  let text: string;
  try { text = await readFile(filename, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const receipt = JSON.parse(text) as ArchiveReceipt;
  if (receipt.day !== day || !CID.test(receipt.cid) || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 ||
      !Number.isSafeInteger(receipt.cellCount) || receipt.cellCount <= 0 ||
      !Number.isFinite(Date.parse(receipt.archivedAt))) throw new Error('Invalid archive receipt');
  return receipt;
}

async function persistFirst(directory: string, receipt: ArchiveReceipt): Promise<ArchiveReceipt> {
  const filename = path.join(directory, `${receipt.day}.json`);
  const temporary = path.join(directory, `.${receipt.day}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(receipt)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    // Hard-link installation is atomic and cannot overwrite a competing receipt.
    try { await link(temporary, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    const stored = await readReceipt(filename, receipt.day);
    if (!stored) throw new Error('Archive receipt unavailable');
    return stored;
  } finally { await unlink(temporary); }
}

export async function archiveWeatherDay(
  source: ReleaseSource, storage: IpfsSink, directory: string, day: string, now: Date = new Date(),
): Promise<ArchiveReceipt> {
  if (!validDay(day, now)) throw new Error('Day is not eligible');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readReceipt(path.join(directory, `${day}.json`), day);
  if (existing) return existing;
  const { rows } = await source.query(ARCHIVE_RELEASE_SQL, [day]);
  if (rows.length === 0) throw new Error('No published daily summary');
  if (rows.length > MAX_CELLS) throw new Error('Daily summary exceeds archive limit');
  const cells = rows.map(cell).filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((a, b) => a.latE1 - b.latE1 || a.lonE1 - b.lonE1);
  if (cells.length === 0) throw new Error('No published daily summary');
  if (cells.some((value, index) => index > 0 && value.latE1 === cells[index - 1].latE1 && value.lonE1 === cells[index - 1].lonE1)) {
    throw new Error('Invalid daily release');
  }
  const bytes = Buffer.from(JSON.stringify({ schema: SCHEMA, day, cells }));
  if (bytes.length > MAX_BYTES) throw new Error('Daily summary exceeds archive limit');
  let cid: string;
  try {
    const stored = await storage.storeIpfs(bytes, 'application/json', { day, schema: SCHEMA });
    cid = stored.content_id.hash;
    if (stored.provider !== 'ipfs' || stored.content_id.provider !== 'ipfs' ||
        !CID.test(cid) || stored.size !== bytes.length) throw new Error('Invalid IPFS receipt');
  } catch { throw new Error('IPFS archive is unavailable'); }
  return persistFirst(directory, {
    day, cid, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    cellCount: cells.length, archivedAt: now.toISOString(),
  });
}

/** Bounded backfill; older releases can be archived explicitly with archiveWeatherDay. */
export async function archiveReleasedDays(
  source: ReleaseSource, storage: IpfsSink, directory: string, now: Date = new Date(),
): Promise<{ day: string; status: 'archived' | 'unavailable' }[]> {
  const { rows } = await source.query(`
    SELECT to_char(day, 'YYYY-MM-DD') AS day FROM (
      SELECT DISTINCT day FROM weather_temperature_daily_release
      WHERE day < $1::date AND min_c IS NOT NULL
      ORDER BY day DESC LIMIT 14
    ) AS released_days ORDER BY day DESC`, [eligibleDayBoundary(now)]);
  const results: { day: string; status: 'archived' | 'unavailable' }[] = [];
  for (const row of rows) {
    const day = String(row.day);
    if (!validDay(day, now)) throw new Error('Invalid released day');
    try {
      await archiveWeatherDay(source, storage, directory, day, now);
      results.push({ day, status: 'archived' });
    } catch { results.push({ day, status: 'unavailable' }); }
  }
  return results;
}
