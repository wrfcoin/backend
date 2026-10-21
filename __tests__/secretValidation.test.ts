import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import path from 'path';

import {
  createEnvTemplate,
  requiredSecrets,
} from '../utils/secretValidation.js';

const envExample = readFileSync(
  path.join(__dirname, '..', '.env.example'),
  'utf8'
);

describe('secret validation bootstrap', () => {
  it('includes API_KEY_ENCRYPTION_KEY in required secrets and the env template', () => {
    expect(requiredSecrets).toContain('API_KEY_ENCRYPTION_KEY');

    const template = createEnvTemplate();

    expect(template).toContain('API_KEY_ENCRYPTION_KEY=');
    expect(template).toMatch(/API_KEY_ENCRYPTION_KEY=[a-f0-9]+/);
  });

  it('documents required runtime secrets in .env.example', () => {
    for (const secret of requiredSecrets) {
      expect(envExample).toContain(`${secret}=`);
    }

    const productionRequiredSecrets = [
      'JWT_REFRESH_SECRET',
      'OPENFORIS_JWT_SECRET',
      'SESSION_SECRET',
      'WORMHOLE_EVM_RPC_URL',
      'WORMHOLE_GUARDIAN_RPC',
      'WORMHOLE_SOLANA_RPC_URL',
    ];

    for (const secret of productionRequiredSecrets) {
      expect(envExample).toContain(`${secret}=`);
    }
  });
});
