import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import express from 'express';
import { StorageProvidersClient } from '../server/services/storage-providers-client';
import { archiveWeatherDay, archiveReleasedDays } from '../server/services/weather-ipfs-archive';

const CID = 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51';
const day = '2026-10-01';
const now = new Date('2026-10-02T03:00:00Z');
let directory: string;
let query: jest.Mock;
let storeIpfs: jest.Mock;
const row = { lat_e1: 100, lon_e1: 200, min_c: '20.0', max_c: '22.0', mean_c: '21.5', count_bucket: 10 };

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'sol-l-weather-archive-'));
  query = jest.fn().mockResolvedValue({ rows: [row] });
  storeIpfs = jest.fn(async (bytes: Buffer) => ({
    content_id: { provider: 'ipfs', hash: CID }, provider: 'ipfs', size: bytes.length, timestamp: 1790902800,
  }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const archive = (date = day, at = now) => archiveWeatherDay({ query }, { storeIpfs }, directory, date, at);

test('archives only the published allowlist, with integer tenths and a durable CID per day', async () => {
  query.mockResolvedValue({ rows: [{ ...row, latitude: 10.012345, longitude: 20.056789, wallet_address: 'synthetic-private-wallet', samples: ['synthetic-raw-reading'] }] });
  const receipt = await archive();
  const [bytes, contentType, tags] = storeIpfs.mock.calls[0];
  expect(JSON.parse(bytes.toString())).toEqual({
    schema: 'weather-temperature-daily/v1', day,
    cells: [{ latE1: 100, lonE1: 200, minC: 20, maxC: 22, meanC: 21.5, countBucket: 10 }],
  });
  expect(bytes.toString()).not.toMatch(/10\.012345|20\.056789|wallet|synthetic-raw/);
  expect(contentType).toBe('application/json');
  expect(tags).toEqual({ day, schema: 'weather-temperature-daily/v1' });
  expect(query.mock.calls[0][0]).toMatch(/FROM weather_temperature_daily_release/);
  expect(query.mock.calls[0][0]).not.toMatch(/weather_submissions/);
  expect(query.mock.calls[0][1]).toEqual([day]);
  expect(receipt).toEqual(expect.objectContaining({ day, cid: CID, cellCount: 1, bytes: bytes.length, archivedAt: now.toISOString() }));
  expect(JSON.parse(await readFile(path.join(directory, `${day}.json`), 'utf8'))).toEqual(receipt);
});

test('a restart returns the first receipt without querying, uploading or revising the snapshot', async () => {
  const first = await archive();
  query.mockRejectedValue(new Error('database offline'));
  storeIpfs.mockRejectedValue(new Error('daemon offline'));
  expect(await archive()).toEqual(first);
  expect(query).toHaveBeenCalledTimes(1);
  expect(storeIpfs).toHaveBeenCalledTimes(1);
});

test('a suppressed-only day is indistinguishable from an empty day: no public archive or receipt', async () => {
  query.mockResolvedValue({ rows: [{ ...row, min_c: null, max_c: null, mean_c: null, count_bucket: null }] });
  await expect(archive()).rejects.toThrow('No published daily summary');
  expect(storeIpfs).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

test('suppressed-cell coordinates and counts never enter a mixed public archive', async () => {
  query.mockResolvedValue({ rows: [row, { ...row, lat_e1: 300, lon_e1: 400,
    min_c: null, max_c: null, mean_c: null, count_bucket: null }] });
  const receipt = await archive();
  expect(JSON.parse(storeIpfs.mock.calls[0][0].toString()).cells).toEqual([
    { latE1: 100, lonE1: 200, minC: 20, maxC: 22, meanC: 21.5, countBucket: 10 },
  ]);
  expect(receipt.cellCount).toBe(1);
});

test('adding suppressed cells leaves public archive bytes and content digest unchanged', async () => {
  const first = await archive();
  const bytes = storeIpfs.mock.calls[0][0];
  await rm(path.join(directory, `${day}.json`));
  query.mockResolvedValue({ rows: [row, { ...row, lat_e1: -300, lon_e1: -400,
    min_c: null, max_c: null, mean_c: null, count_bucket: null }] });
  await archive();
  expect(storeIpfs.mock.calls[1][0]).toEqual(bytes);
  expect(JSON.parse(await readFile(path.join(directory, `${day}.json`), 'utf8')).sha256).toBe(first.sha256);
});

test('the real migration runner discovers a later day-leading archive index without data changes', () => {
  const migrations = readMigrationFiles({ migrationsFolder: path.join(process.cwd(), 'drizzle/migrations') });
  const archiveIndex = migrations.find(m => m.sql.some(sql => /weather_temperature_daily_release_day_cells_idx/.test(sql)));
  const releaseTable = migrations.find(m => m.sql.some(sql => /CREATE TABLE IF NOT EXISTS "weather_temperature_daily_release"/.test(sql)));
  expect(archiveIndex).toBeDefined();
  expect(releaseTable).toBeDefined();
  expect(archiveIndex!.folderMillis).toBeGreaterThan(releaseTable!.folderMillis);
  const sql = archiveIndex!.sql.join('\n').split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "weather_temperature_daily_release_day_cells_idx"\s+ON "weather_temperature_daily_release" \("day", "lat_e1", "lon_e1"\)/);
  expect(sql).not.toMatch(/DROP|DELETE|UPDATE|TRUNCATE|CONCURRENTLY/i);
});

test.each([
  { lat_e1: 100.123 }, { lon_e1: 1801 }, { mean_c: '21.123' },
  { count_bucket: 11 }, { min_c: null }, { mean_c: 'NaN' },
  { mean_c: false }, { mean_c: '  ' },
])('refuses malformed public release data %j before an upload', async alteration => {
  query.mockResolvedValue({ rows: [{ ...row, ...alteration }] });
  await expect(archive()).rejects.toThrow('Invalid daily release');
  expect(storeIpfs).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

test.each(['2026-10-02', '2026-10-03', '2026-02-30', '../secret'])('refuses an unreleased or invalid day %s', async date => {
  await expect(archive(date)).rejects.toThrow('Day is not eligible');
  expect(query).not.toHaveBeenCalled();
  expect(storeIpfs).not.toHaveBeenCalled();
});

test('keeps the previous day unpublished until its two-hour release grace expires', async () => {
  await expect(archive(day, new Date('2026-10-02T01:59:59Z'))).rejects.toThrow('Day is not eligible');
  expect(query).not.toHaveBeenCalled();
});

test('does not invent an archive for a day with no public release rows', async () => {
  query.mockResolvedValue({ rows: [] });
  await expect(archive()).rejects.toThrow('No published daily summary');
  expect(storeIpfs).not.toHaveBeenCalled();
});

test('an unavailable daemon leaves no receipt and a later retry succeeds', async () => {
  storeIpfs.mockRejectedValueOnce(new Error('private upstream details'));
  await expect(archive()).rejects.toThrow('IPFS archive is unavailable');
  expect(await readdir(directory)).toEqual([]);
  expect((await archive()).cid).toBe(CID);
});

test('concurrent attempts atomically retain one complete first receipt', async () => {
  const receipts = await Promise.all([0, 1, 2].map(seconds => archive(day, new Date(now.getTime() + seconds * 1000))));
  expect(receipts.every(receipt => JSON.stringify(receipt) === JSON.stringify(receipts[0]))).toBe(true);
  expect(await readdir(directory)).toEqual([`${day}.json`]);
  expect(JSON.parse(await readFile(path.join(directory, `${day}.json`), 'utf8'))).toEqual(receipts[0]);
});

test('sorts cells deterministically regardless of release row order', async () => {
  query.mockResolvedValue({ rows: [{ ...row, lat_e1: 200 }, row] });
  await archive();
  expect(JSON.parse(storeIpfs.mock.calls[0][0].toString()).cells.map((cell: { latE1: number }) => cell.latE1)).toEqual([100, 200]);
});

test('rejects duplicate cells rather than publishing contradictory values', async () => {
  query.mockResolvedValue({ rows: [row, { ...row, mean_c: '20.5' }] });
  await expect(archive()).rejects.toThrow('Invalid daily release');
  expect(storeIpfs).not.toHaveBeenCalled();
});

test('refuses an oversized daily rowset without silently truncating it', async () => {
  query.mockResolvedValue({ rows: Array(100_001).fill(row) });
  await expect(archive()).rejects.toThrow('Daily summary exceeds archive limit');
  expect(storeIpfs).not.toHaveBeenCalled();
});

test('bounds raw summary bytes so the base64 JSON fits the real daemon request limit', async () => {
  query.mockResolvedValue({ rows: Array.from({ length: 20_000 }, (_, index) => ({
    ...row, lat_e1: -900 + Math.floor(index / 3601), lon_e1: -1800 + index % 3601,
  })) });
  await expect(archive()).rejects.toThrow('Daily summary exceeds archive limit');
  expect(storeIpfs).not.toHaveBeenCalled();
});

test('the bounded sweep considers only eligible published days and reports unavailable uploads', async () => {
  query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT DISTINCT') ? [{ day }] : [row] }));
  storeIpfs.mockRejectedValueOnce(new Error('synthetic-private-upstream'));
  expect(await archiveReleasedDays({ query }, { storeIpfs }, directory, now)).toEqual([{ day, status: 'unavailable' }]);
  expect(query.mock.calls[0][0]).toMatch(/SELECT DISTINCT day FROM weather_temperature_daily_release/);
  expect(query.mock.calls[0][0]).toMatch(/day < \$1::date AND min_c IS NOT NULL\s+ORDER BY day DESC LIMIT 14/);
  expect(query.mock.calls[0][1]).toEqual(['2026-10-02']);
  expect(await readdir(directory)).toEqual([]);
  expect(await archiveReleasedDays({ query }, { storeIpfs }, directory, now)).toEqual([{ day, status: 'archived' }]);
});

test('the real HTTP client uploads the summary and retrieves its exact archived bytes', async () => {
  const app = express();
  app.use(express.json());
  let content: Buffer | undefined;
  app.post('/api/store', (req, res) => {
    expect(req.body.provider).toBe('ipfs');
    content = Buffer.from(req.body.data, 'base64');
    res.status(201).json({ content_id: { provider: 'ipfs', hash: CID }, provider: 'ipfs', size: content.length, timestamp: 1790902800 });
  });
  app.get('/api/retrieve/:id', (req, res) => {
    expect(req.params.id).toBe(`ipfs:${CID}`);
    res.type('application/octet-stream').send(content);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback unavailable');
    const client = new StorageProvidersClient(`http://127.0.0.1:${address.port}`);
    const receipt = await archiveWeatherDay({ query }, client, directory, day, now);
    expect(await client.retrieveIpfs(receipt.cid)).toEqual(content);
    expect(JSON.parse(content!.toString()).cells[0].latE1).toBe(100);
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});
