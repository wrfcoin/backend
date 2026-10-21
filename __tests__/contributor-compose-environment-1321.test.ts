import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

it('passes only the existing Contributor deployment variable to main-api (#1321)', () => {
  const compose = parse(readFileSync(path.resolve(__dirname, '../docker-compose.testnet.yml'), 'utf8'));
  expect(compose.services['main-api'].environment.filter((entry: string) => entry.startsWith('WRFCOIN_CONTRIBUTOR_TOKEN=')))
    .toEqual(['WRFCOIN_CONTRIBUTOR_TOKEN=${WRFCOIN_CONTRIBUTOR_TOKEN:-}']);
});
