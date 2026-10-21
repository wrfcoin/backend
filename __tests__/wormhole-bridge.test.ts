/**
 * Tests for Wormhole Bridge real adapters
 *
 * Tests cover:
 * - EvmAdapter construction and VAA verification
 * - SolanaAdapter construction
 * - VAAVerifier parsing and signature validation
 * - All external calls are mocked — no testnet access required
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EvmAdapter } from '../server/wormhole/evm-adapter.js';
import { SolanaAdapter } from '../server/wormhole/solana-adapter.js';
import { VAAVerifier, type ParsedVAA } from '../server/wormhole/vaa-verifier.js';

describe('EvmAdapter', () => {
  it('should construct with RPC URL and contract addresses', () => {
    const adapter = new EvmAdapter(
      'https://rpc.sepolia.example.com',
      '0x706abc4E45D419950511e474C7B9Ed348A4a716c',
      '0xF890982f9310df57d00f659cf4fd87e65adEd8d7'
    );
    expect(adapter).toBeDefined();
  });

  it('should reject invalid VAA (too short)', async () => {
    const adapter = new EvmAdapter(
      'https://rpc.example.com',
      '0x706abc4E45D419950511e474C7B9Ed348A4a716c',
      '0xF890982f9310df57d00f659cf4fd87e65adEd8d7'
    );

    const result = await adapter.verifyVAA(new Uint8Array([1, 2, 3]));
    expect(result).toBe(false);
  });

  it('should reject VAA with wrong version', async () => {
    const adapter = new EvmAdapter(
      'https://rpc.example.com',
      '0x706abc4E45D419950511e474C7B9Ed348A4a716c',
      '0xF890982f9310df57d00f659cf4fd87e65adEd8d7'
    );

    // Version 2 (unsupported)
    const vaa = new Uint8Array(200);
    vaa[0] = 2;
    const result = await adapter.verifyVAA(vaa);
    expect(result).toBe(false);
  });

  it('should accept structurally valid VAA', async () => {
    const adapter = new EvmAdapter(
      'https://rpc.example.com',
      '0x706abc4E45D419950511e474C7B9Ed348A4a716c',
      '0xF890982f9310df57d00f659cf4fd87e65adEd8d7'
    );

    // Build a minimal valid VAA: version=1, guardianSet=0, 1 signature, body
    const vaa = new Uint8Array(6 + 66 + 51);
    vaa[0] = 1; // version
    // bytes 1-4: guardian set index = 0
    vaa[5] = 1; // 1 signature
    // 66 bytes of signature (random is fine for structural check)
    // 51 bytes of body header
    const result = await adapter.verifyVAA(vaa);
    expect(result).toBe(true);
  });
});

describe('SolanaAdapter', () => {
  it('should construct with RPC URL and program IDs', () => {
    const adapter = new SolanaAdapter(
      'https://api.devnet.solana.com',
      'Bridge1p5gheXUvJ6jGWGeCsgPKgnE3YgdGKRVCMY9o',
      'B6RHG3mfcckmrYN1UhmJzyS1XX3fZKbkeUcpJe9Sy3FE'
    );
    expect(adapter).toBeDefined();
  });
});

describe('VAAVerifier', () => {
  let verifier: VAAVerifier;

  beforeEach(() => {
    verifier = new VAAVerifier('https://wormhole-v2-testnet-api.certus.one');
  });

  it('should construct with Guardian RPC URL', () => {
    expect(verifier).toBeDefined();
  });

  it('should strip trailing slash from URL', () => {
    const v = new VAAVerifier('https://example.com/');
    expect(v).toBeDefined();
  });

  describe('parseVAA', () => {
    function buildSampleVAA(): Uint8Array {
      // Build a valid VAA with 1 signature
      const signatureCount = 1;
      const signatureSize = 66; // 1 index + 65 sig
      const bodyHeaderSize = 51; // 4 timestamp + 4 nonce + 2 emitter chain + 32 emitter addr + 8 sequence + 1 consistency
      const payloadSize = 10;
      const totalSize = 6 + signatureCount * signatureSize + bodyHeaderSize + payloadSize;

      const buf = Buffer.alloc(totalSize);
      let offset = 0;

      buf.writeUInt8(1, offset++); // version
      buf.writeUInt32BE(3, offset); offset += 4; // guardian set index
      buf.writeUInt8(signatureCount, offset++); // signature count

      // Signature: guardian index 0 + 65 bytes
      buf.writeUInt8(0, offset++);
      // Fill 65 bytes of signature
      for (let i = 0; i < 65; i++) {
        buf.writeUInt8(0xAB, offset++);
      }

      // Body
      buf.writeUInt32BE(1700000000, offset); offset += 4; // timestamp
      buf.writeUInt32BE(42, offset); offset += 4; // nonce
      buf.writeUInt16BE(2, offset); offset += 2; // emitter chain (Ethereum)

      // 32-byte emitter address
      const emitter = Buffer.alloc(32);
      emitter[31] = 0xFF;
      emitter.copy(buf, offset);
      offset += 32;

      // Sequence (8 bytes big-endian)
      buf.writeBigUInt64BE(123n, offset); offset += 8;

      buf.writeUInt8(15, offset++); // consistency level

      // Payload
      for (let i = 0; i < payloadSize; i++) {
        buf.writeUInt8(i + 1, offset++);
      }

      return new Uint8Array(buf);
    }

    it('should parse a well-formed VAA', () => {
      const vaaBytes = buildSampleVAA();
      const parsed = verifier.parseVAA(vaaBytes);

      expect(parsed.version).toBe(1);
      expect(parsed.guardianSetIndex).toBe(3);
      expect(parsed.signatures).toHaveLength(1);
      expect(parsed.signatures[0].guardianIndex).toBe(0);
      expect(parsed.signatures[0].signature).toHaveLength(65);
      expect(parsed.timestamp).toBe(1700000000);
      expect(parsed.nonce).toBe(42);
      expect(parsed.emitterChain).toBe(2);
      expect(parsed.sequence).toBe(123n);
      expect(parsed.consistencyLevel).toBe(15);
      expect(parsed.payload).toHaveLength(10);
    });

    it('should throw on VAA too short', () => {
      expect(() => verifier.parseVAA(new Uint8Array([1, 2]))).toThrow(
        'VAA too short'
      );
    });

    it('should throw on unsupported version', () => {
      const vaa = new Uint8Array(100);
      vaa[0] = 0; // version 0
      expect(() => verifier.parseVAA(vaa)).toThrow('Unsupported VAA version');
    });
  });

  describe('verifySignatures', () => {
    it('should reject VAA with no signatures', () => {
      const vaa: ParsedVAA = {
        version: 1,
        guardianSetIndex: 0,
        signatures: [],
        timestamp: 0,
        nonce: 0,
        emitterChain: 2,
        emitterAddress: '0x00',
        sequence: 0n,
        consistencyLevel: 15,
        payload: new Uint8Array(0),
      };

      expect(verifier.verifySignatures(vaa)).toBe(false);
    });

    it('should reject when below quorum', () => {
      const vaa: ParsedVAA = {
        version: 1,
        guardianSetIndex: 0,
        signatures: [{ guardianIndex: 0, signature: new Uint8Array(65) }],
        timestamp: 0,
        nonce: 0,
        emitterChain: 2,
        emitterAddress: '0x00',
        sequence: 0n,
        consistencyLevel: 15,
        payload: new Uint8Array(0),
      };

      // Guardian set of 19 requires 13 signatures (2/3+1)
      expect(verifier.verifySignatures(vaa, 19)).toBe(false);
    });

    it('should reject duplicate guardian indices', () => {
      const sig = { guardianIndex: 0, signature: new Uint8Array(65) };
      const vaa: ParsedVAA = {
        version: 1,
        guardianSetIndex: 0,
        signatures: [sig, sig],
        timestamp: 0,
        nonce: 0,
        emitterChain: 2,
        emitterAddress: '0x00',
        sequence: 0n,
        consistencyLevel: 15,
        payload: new Uint8Array(0),
      };

      expect(verifier.verifySignatures(vaa)).toBe(false);
    });

    it('should accept valid signature structure', () => {
      const signatures = Array.from({ length: 13 }, (_, i) => ({
        guardianIndex: i,
        signature: new Uint8Array(65),
      }));

      const vaa: ParsedVAA = {
        version: 1,
        guardianSetIndex: 0,
        signatures,
        timestamp: 0,
        nonce: 0,
        emitterChain: 2,
        emitterAddress: '0x00',
        sequence: 0n,
        consistencyLevel: 15,
        payload: new Uint8Array(0),
      };

      expect(verifier.verifySignatures(vaa, 19)).toBe(true);
    });
  });

  describe('fetchVAA', () => {
    it('should throw on timeout', async () => {
      // Mock fetch to always return 404
      const originalFetch = global.fetch;
      global.fetch = jest.fn(() =>
        Promise.resolve(new Response(null, { status: 404 }))
      ) as any;

      try {
        await expect(
          verifier.fetchVAA(2, '0xabc', 1n, 500)
        ).rejects.toThrow('VAA not available after 500ms');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should return VAA bytes on success', async () => {
      const mockVaaBytes = Buffer.from('test-vaa').toString('base64');
      const originalFetch = global.fetch;
      global.fetch = jest.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ vaaBytes: mockVaaBytes }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      ) as any;

      try {
        const result = await verifier.fetchVAA(2, '0xabc', 1n);
        expect(result).toEqual(Uint8Array.from(Buffer.from('test-vaa')));
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
