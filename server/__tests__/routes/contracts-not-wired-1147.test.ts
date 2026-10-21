/**
 * backend#1147 — POST /api/contracts/deploy and /api/contracts/call answered
 * a fabricated contract address, tx hash, gas, block number and (for
 * submitWeatherData) a fake 0.125 WRF reward, generated with crypto-quality
 * randomness so the values looked real. No deploy/call path exists in core4's
 * launch API, blockchain_adapter or any mounted router (checked), so there is
 * no real path to wire: both answer the honest-gap 501 envelope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';


const { notWiredEnvelope, NOT_WIRED_CODE } = require('../../middleware/require-wired-storage');

const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'enhanced_unified_api_optimized.ts'), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = stripComments(entrypoint);

describe('contracts handlers (backend#1147)', () => {
  it('deploy and call answer the not-wired envelope, never a success body', () => {
    const block = code.slice(code.indexOf('path.startsWith(\'/api/contracts/\')'), code.indexOf('error(404, \'Contract endpoint not found\')'));
    expect(block).toMatch(/notWired\(\s*'contracts\.deploy'/);
    expect(block).toMatch(/notWired\(\s*'contracts\.call'/);
    expect(block).not.toMatch(/success\(/);
    expect(block).not.toMatch(/contractAddress|transactionHash|rewardAmount|validationScore|gasUsed|blockNumber/);
  });

  it('the crypto-quality fabrication helpers are gone from the entrypoint', () => {
    expect(code).not.toMatch(/secureHex\(|secureRandom\(/);
  });

  it('the envelope a caller receives is the backend#1118 honest-gap shape', () => {
    const env = notWiredEnvelope({ capability: 'contracts.deploy', message: 'm', details: 'd', see: 'wrfcoin/backend#1147' });
    expect(env).toMatchObject({ success: false, unavailable: true, reason: 'm', error: { code: NOT_WIRED_CODE, capability: 'contracts.deploy', see: 'wrfcoin/backend#1147' } });
  });
});
