import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { createWalletAuthService } from '../server/routes/wallet-auth-service';

jest.mock('../server/utils/logger.js', () => ({ appLogger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const variables = ['WRFCOIN_OPERATOR_TOKEN', 'WRFCOIN_MINING_REWARD_ADDRESS', 'WRFCOIN_ADMIN_NFT_MINT_CONFIG',
  'WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG', 'WRFCOIN_ADMIN_STEALTH_CONFIG', 'WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG',
  'WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS', 'WRFCOIN_GOVERNANCE_SIGNING_VERSION', 'WRFCOIN_GOVERNANCE_CHAIN_ID', 'WRFCOIN_GOVERNANCE_NETWORK_ID'];
it.each(variables)('passes only an existing %s value to main-api, default empty', variable => {
  const compose = parse(readFileSync(path.resolve(__dirname, '../docker-compose.testnet.yml'), 'utf8'));
  expect(compose.services['main-api'].environment.filter((line: string) => line.startsWith(`${variable}=`)))
    .toEqual([`${variable}=\${${variable}:-}`]);
});
it('does not inject empty shared wallet-login identity variables for optional governance', () => {
  const compose = parse(readFileSync(path.resolve(__dirname, '../docker-compose.testnet.yml'), 'utf8'));
  expect(compose.services['main-api'].environment.filter((line: string) => /^WRFCOIN_(?:CHAIN_ID|NETWORK_ID)=/.test(line))).toEqual([]);
});
it('keeps wallet login constructible when optional governance configuration is unset', () => {
  const compose = parse(readFileSync(path.resolve(__dirname, '../docker-compose.testnet.yml'), 'utf8'));
  const keys = ['WRFCOIN_CHAIN_ID', 'WRFCOIN_NETWORK_ID', 'WRFCOIN_WALLET_AUTH_CHAIN_ID', 'WRFCOIN_WALLET_AUTH_NETWORK'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    // Compose's newly added default-empty identity lines would suppress the
    // service's existing nullish defaults. Exercise the real constructor.
    for (const line of compose.services['main-api'].environment as string[]) {
      const match = line.match(/^(WRFCOIN_(?:CHAIN_ID|NETWORK_ID))=\$\{\1:-\}$/);
      if (match) process.env[match[1]] = '';
    }
    expect(() => createWalletAuthService({ db: { execute: async () => ({ rows: [] }) },
      jwtSecret: 'test-only-compose-wallet-auth-secret-00000000000', walletAuthOrigin: 'http://localhost:5000' })).not.toThrow();
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
