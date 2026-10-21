import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const retired = ['storage_networks_server.js', 'nas_storage_server.js', 'nas_storage_server.ts'];
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

test.each(retired)('retired mock %s cannot be imported or launched from the backend', file => {
  expect(existsSync(path.join(root, 'server', file))).toBe(false);
});

test('active registry, package and local compose contain no retired launch targets', () => {
  for (const file of ['config/microservices.json', 'package.json', 'docker-compose.testnet.yml', 'server/SERVICE_REGISTRY.md']) {
    const source = read(file);
    for (const retiredFile of retired) expect(source).not.toContain(retiredFile);
  }
  expect(read('docker-compose.testnet.yml')).not.toMatch(/^  storage:\s*$/m);
  expect(JSON.parse(read('config/microservices.json')).services.storage).toBeUndefined();
});

test('development instructions use the real IPFS daemon and acknowledged CID path', () => {
  const source = read('docs/storage-ipfs-development.md');
  expect(source).toContain('WRFCOIN_STORAGE_NODE_URL');
  expect(source).toContain('ipfs-storage');
  expect(source).toContain('POST /api/store');
  expect(source).toContain('GET /api/retrieve/ipfs:CID');
  expect(source).toContain('acknowledged CID');
});
