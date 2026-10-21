import express from 'express';
import type { Server } from 'node:http';
import { StorageProvidersClient } from '../server/services/storage-providers-client';

// Synthetic CIDv0: base58(multihash sha2-256 tag + 32 zero digest bytes).
const CID = 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51';
const bytes = Buffer.from('daily weather: 21.5 °C');
let server: Server;
let client: StorageProvidersClient;
let upload: Record<string, unknown> | undefined;
let receipt: Record<string, unknown>;
let upstreamStatus: number;
let retrievalStatus: number;

beforeEach(async () => {
  upload = undefined;
  upstreamStatus = 201;
  retrievalStatus = 200;
  receipt = { content_id: { provider: 'ipfs', hash: CID }, provider: 'ipfs', size: bytes.length, timestamp: 1790942400 };
  const app = express();
  app.use(express.json());
  app.post('/api/store', (req, res) => {
    upload = req.body;
    res.status(upstreamStatus).json(receipt);
  });
  app.get('/api/retrieve/:id', (req, res) => {
    if (req.params.id !== `ipfs:${CID}`) return res.sendStatus(404);
    res.status(retrievalStatus).type('application/octet-stream').send(bytes);
  });
  await new Promise<void>(done => { server = app.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no loopback port');
  client = new StorageProvidersClient(`http://127.0.0.1:${address.port}`);
});
afterEach(async () => {
  if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
});

test('uploads UTF-8 bytes through the real storage-node request/receipt shape', async () => {
  const stored = await client.storeIpfs(bytes, 'application/json', { day: '2026-10-01' });
  expect(upload).toEqual({ data: bytes.toString('base64'), content_type: 'application/json', provider: 'ipfs', tags: { day: '2026-10-01' } });
  expect(stored).toEqual(receipt);
});

test('retrieves byte-exact content through the provider:CID route', async () => {
  expect(await client.retrieveIpfs(CID)).toEqual(bytes);
});

test.each([
  'bafybeiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
])('preserves a valid synthetic SHA-256 CIDv1 receipt %s', async cid => {
  receipt = { ...receipt, content_id: { provider: 'ipfs', hash: cid } };
  expect((await client.storeIpfs(bytes)).content_id.hash).toBe(cid);
});

test.each([200, 503])('refuses HTTP %s instead of an acknowledged create', async status => {
  upstreamStatus = status;
  await expect(client.storeIpfs(bytes)).rejects.toThrow('IPFS storage is unavailable');
});

test.each([
  { provider: 'filecoin' },
  { content_id: { provider: 'arweave', hash: CID } },
  { content_id: { provider: 'ipfs', hash: 'fabricated-id' } },
  { content_id: { provider: 'ipfs', hash: 'b'.repeat(60) } },
  { timestamp: -1 },
  { timestamp: '1790942400' },
  { size: bytes.length - 1 },
])('rejects an incoherent store receipt %j', async alteration => {
  receipt = { ...receipt, ...alteration };
  await expect(client.storeIpfs(bytes)).rejects.toThrow('IPFS storage is unavailable');
});

test('reports transport loss without inventing a CID', async () => {
  await new Promise<void>(done => server.close(() => done()));
  await expect(client.storeIpfs(bytes)).rejects.toThrow('IPFS storage is unavailable');
});

test('rejects non-CID retrieval identifiers before a request', async () => {
  await expect(client.retrieveIpfs('../private')).rejects.toThrow('Invalid IPFS CID');
});

test.each([201, 204, 503])('reports an HTTP %s retrieval as unavailable', async status => {
  retrievalStatus = status;
  await expect(client.retrieveIpfs(CID)).rejects.toThrow('IPFS storage is unavailable');
});
