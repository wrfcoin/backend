/**
 * The HSM transaction-signing service is retired (owner ruling 2026-10-03,
 * S55 item 27; backend#1006).
 *
 * services/hsm-transaction-service.ts imported an undeclared native module
 * (graphene-pk11), could not be imported at all, and nothing live called it.
 * Its only consumer, BlockchainAdapter.submitL1Transaction(), had no callers.
 * Pure file checks: nothing here may import the retired code.
 *
 * blockchain/signers/hsm-signer.ts is a different module (EVM smart-contract
 * signing) and is intentionally NOT covered by this retirement.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('retired HSM transaction-signing service', () => {
  it('has no service file and no service test', () => {
    expect(fs.existsSync(path.join(ROOT, 'services', 'hsm-transaction-service.ts'))).toBe(false);
    expect(
      fs.existsSync(path.join(ROOT, '__tests__', 'carbon-credit', 'hsm-transaction-service.test.ts'))
    ).toBe(false);
  });

  it('is not reachable from the blockchain adapter', () => {
    const adapter = read('server/blockchain_adapter.js');
    expect(adapter).not.toContain('hsm-transaction-service');
    expect(adapter).not.toContain('getHSMModule');
    expect(adapter).not.toContain('submitL1Transaction');
  });

  it('is not referenced by key-manager guidance', () => {
    expect(read('server/utils/keyManager.js')).not.toContain('submitL1Transaction');
  });
});
