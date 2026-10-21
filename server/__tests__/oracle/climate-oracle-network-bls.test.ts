import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../database/db', () => ({
  db: {},
  pool: {},
}));

jest.mock('../../../shared/schema', () => ({
  validators: {},
}));

jest.mock('../../../shared/oracle-schema', () => ({
  oracleRequests: {},
  oracleResponses: {},
  crossChainBridges: {},
  validatorOracleParticipation: {},
  bridgeTransactions: {},
}));

jest.mock('../../utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  crosschainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logError: jest.fn(),
}));

jest.mock('../../oracle/rust-oracle-bridge', () => ({
  RustOracleBridge: class MockRustOracleBridge {
    async initialize(): Promise<boolean> {
      return true;
    }
    isHealthy(): boolean {
      return false;
    }
    async submitCrossChainOracleRequest(): Promise<any> {
      return {
        result: {},
        validator_consensus: {
          achieved_consensus: 0,
          participating_validators: [],
        },
      };
    }
  },
}));

// climate-oracle-network.ts uses CommonJS export style.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ClimateOracleNetwork } = require('../../oracle/climate-oracle-network');

type TestValidator = {
  id: number;
  validatorId: number;
  name: string;
  public_key: string;
};

function buildValidators(): TestValidator[] {
  return [
    { id: 1, validatorId: 1, name: 'Validator-1', public_key: 'pub_key_1' },
    { id: 2, validatorId: 2, name: 'Validator-2', public_key: 'pub_key_2' },
    { id: 3, validatorId: 3, name: 'Validator-3', public_key: 'pub_key_3' },
  ];
}

describe('ClimateOracleNetwork BLS aggregate proofs', () => {
  it('generates and verifies deterministic BLS aggregate proof', async () => {
    const network = new ClimateOracleNetwork() as any;
    const validators = buildValidators();
    network.validators = validators;

    const messageHash = network.createCanonicalBLSMessageHash({
      requestId: 'req-001',
      dataType: 'TEMPERATURE',
      parameters: { latitude: 12.34, longitude: 56.78 },
    });

    const validatorSignatures = await Promise.all(
      validators.map(validator =>
        network.createValidatorSignature(
          validator,
          { temperature: 22.5, unit: 'celsius' },
          messageHash
        )
      )
    );

    const proof = await network.generateBLSProof(validatorSignatures);
    expect(proof.messageHash).toBe(messageHash);
    expect(proof.verification.aggregateSignatureValid).toBe(true);
    expect(proof.signerIds).toEqual([1, 2, 3]);
    expect(proof.serialization.format).toBe('wrfcoin-bls-aggregate-proof-v1');
    await expect(network.verifyBLSAggregateProof(proof)).resolves.toBe(true);
  });

  it('rejects malformed validator signatures', async () => {
    const network = new ClimateOracleNetwork() as any;
    const validators = buildValidators();
    network.validators = validators;

    const messageHash = network.createCanonicalBLSMessageHash({
      requestId: 'req-002',
      dataType: 'HUMIDITY',
      parameters: { region: 'north' },
    });

    const validatorSignatures = await Promise.all(
      validators.map(validator =>
        network.createValidatorSignature(
          validator,
          { humidity: 73 },
          messageHash
        )
      )
    );
    validatorSignatures[0].signature = `ff${validatorSignatures[0].signature.slice(2)}`;

    await expect(network.generateBLSProof(validatorSignatures)).rejects.toThrow(
      /Invalid validator BLS signature|invalid G1 point/
    );
  });

  it('rejects duplicate signers in aggregate proofs', async () => {
    const network = new ClimateOracleNetwork() as any;
    const validators = buildValidators();
    network.validators = validators;

    const messageHash = network.createCanonicalBLSMessageHash({
      requestId: 'req-003',
      dataType: 'PRECIPITATION',
      parameters: { location: 'station-7' },
    });

    const signatures = await Promise.all(
      validators.map(validator =>
        network.createValidatorSignature(
          validator,
          { precipitation: 6.5, unit: 'mm' },
          messageHash
        )
      )
    );

    const duplicateSignerPayload = [
      signatures[0],
      { ...signatures[1], validatorId: signatures[0].validatorId },
      signatures[2],
    ];

    await expect(
      network.generateBLSProof(duplicateSignerPayload)
    ).rejects.toThrow(/Duplicate validator signer/);
  });

  it('detects bitmap mismatch during proof verification', async () => {
    const network = new ClimateOracleNetwork() as any;
    const validators = buildValidators();
    network.validators = validators;

    const messageHash = network.createCanonicalBLSMessageHash({
      requestId: 'req-004',
      dataType: 'WIND',
      parameters: { region: 'coastal' },
    });

    const signatures = await Promise.all(
      validators.map(validator =>
        network.createValidatorSignature(
          validator,
          { windSpeed: 14.2, windDirection: 120 },
          messageHash
        )
      )
    );

    const proof = await network.generateBLSProof(signatures);
    const tamperedBitmap = Buffer.from(proof.bitmap, 'hex');
    tamperedBitmap[0] ^= 0x01;

    await expect(
      network.verifyBLSAggregateProof({
        ...proof,
        bitmap: tamperedBitmap.toString('hex'),
      })
    ).resolves.toBe(false);
  });
});
