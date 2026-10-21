import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

describe('testnet main-api Reader credential boundary (#1284)', () => {
  it('passes the deployment Reader variable to the container without a default credential', () => {
    const compose = parse(readFileSync(path.resolve(__dirname, '../docker-compose.testnet.yml'), 'utf8'));
    const environment: string[] = compose.services['main-api'].environment;
    const reader = environment.filter((entry) => entry.startsWith('WRFCOIN_READER_TOKEN='));

    // Host variables are not inherited by Compose containers automatically.
    // A literal token or a different variable would also violate this boundary.
    expect(reader).toEqual(['WRFCOIN_READER_TOKEN=${WRFCOIN_READER_TOKEN:-}']);
  });
});
