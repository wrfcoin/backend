/**
 * Wormhole VAA (Verified Action Approval) Verifier
 *
 * Fetches and verifies VAAs from the Wormhole Guardian network.
 * Uses the Guardian REST API to poll for signed VAAs.
 */

export interface ParsedVAA {
  version: number;
  guardianSetIndex: number;
  signatures: { guardianIndex: number; signature: Uint8Array }[];
  timestamp: number;
  nonce: number;
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  consistencyLevel: number;
  payload: Uint8Array;
}

export class VAAVerifier {
  private guardianRpcUrl: string;

  constructor(guardianRpcUrl: string) {
    this.guardianRpcUrl = guardianRpcUrl.replace(/\/$/, '');
  }

  /**
   * Fetch a signed VAA from the Guardian network.
   * Polls with exponential backoff until the VAA is available or timeout.
   */
  async fetchVAA(
    emitterChain: number,
    emitterAddress: string,
    sequence: bigint,
    timeoutMs: number = 120_000
  ): Promise<Uint8Array> {
    const startTime = Date.now();
    let delay = 1000; // Start with 1s

    // Normalize emitter address to hex without 0x prefix, zero-padded to 64 chars
    const normalizedEmitter = emitterAddress
      .replace(/^0x/, '')
      .padStart(64, '0');

    const url = `${this.guardianRpcUrl}/v1/signed_vaa/${emitterChain}/${normalizedEmitter}/${sequence}`;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(url);

        if (response.ok) {
          const data = (await response.json()) as { vaaBytes?: string };
          if (data.vaaBytes) {
            return Uint8Array.from(Buffer.from(data.vaaBytes, 'base64'));
          }
        }

        if (response.status === 404) {
          // VAA not yet available, retry after delay
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, 10_000); // Cap at 10s
          continue;
        }

        throw new Error(
          `Guardian API error: ${response.status} ${response.statusText}`
        );
      } catch (error) {
        if (Date.now() - startTime + delay >= timeoutMs) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`VAA fetch timed out after ${timeoutMs}ms: ${message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.5, 10_000);
      }
    }

    throw new Error(
      `VAA not available after ${timeoutMs}ms for chain=${emitterChain} emitter=${normalizedEmitter} seq=${sequence}`
    );
  }

  /**
   * Parse a VAA from raw bytes into its structured components.
   * VAA format: https://docs.wormhole.com/wormhole/explore-wormhole/vaa
   */
  parseVAA(vaaBytes: Uint8Array): ParsedVAA {
    if (vaaBytes.length < 6) {
      throw new Error('VAA too short to contain header');
    }

    const view = new DataView(vaaBytes.buffer, vaaBytes.byteOffset, vaaBytes.byteLength);
    let offset = 0;

    // Version (1 byte)
    const version = vaaBytes[offset++];
    if (version !== 1) {
      throw new Error(`Unsupported VAA version: ${version}`);
    }

    // Guardian set index (4 bytes, big-endian)
    const guardianSetIndex = view.getUint32(offset);
    offset += 4;

    // Signature count (1 byte)
    const signatureCount = vaaBytes[offset++];

    // Parse signatures (66 bytes each: 1 guardian index + 65 signature)
    const signatures: { guardianIndex: number; signature: Uint8Array }[] = [];
    for (let i = 0; i < signatureCount; i++) {
      const guardianIndex = vaaBytes[offset++];
      const signature = vaaBytes.slice(offset, offset + 65);
      offset += 65;
      signatures.push({ guardianIndex, signature });
    }

    // Body starts here
    if (vaaBytes.length < offset + 51) {
      throw new Error('VAA body too short');
    }

    // Timestamp (4 bytes)
    const timestamp = view.getUint32(offset);
    offset += 4;

    // Nonce (4 bytes)
    const nonce = view.getUint32(offset);
    offset += 4;

    // Emitter chain (2 bytes)
    const emitterChain = view.getUint16(offset);
    offset += 2;

    // Emitter address (32 bytes)
    const emitterAddressBytes = vaaBytes.slice(offset, offset + 32);
    const emitterAddress =
      '0x' + Buffer.from(emitterAddressBytes).toString('hex');
    offset += 32;

    // Sequence (8 bytes, big-endian)
    const sequence = view.getBigUint64(offset);
    offset += 8;

    // Consistency level (1 byte)
    const consistencyLevel = vaaBytes[offset++];

    // Payload (rest of bytes)
    const payload = vaaBytes.slice(offset);

    return {
      version,
      guardianSetIndex,
      signatures,
      timestamp,
      nonce,
      emitterChain,
      emitterAddress,
      sequence,
      consistencyLevel,
      payload,
    };
  }

  /**
   * Basic signature count verification.
   * A valid VAA requires signatures from 2/3+1 of the guardian set.
   * Without knowing the current guardian set size, we verify structural validity
   * and that at least 1 signature is present.
   */
  verifySignatures(
    vaa: ParsedVAA,
    expectedGuardianSetSize?: number
  ): boolean {
    if (vaa.signatures.length === 0) {
      return false;
    }

    if (expectedGuardianSetSize !== undefined) {
      const quorum = Math.floor((expectedGuardianSetSize * 2) / 3) + 1;
      if (vaa.signatures.length < quorum) {
        return false;
      }
    }

    // Verify no duplicate guardian indices
    const indices = new Set(vaa.signatures.map((s) => s.guardianIndex));
    if (indices.size !== vaa.signatures.length) {
      return false;
    }

    // Verify all signatures are the expected length (65 bytes: r + s + v)
    for (const sig of vaa.signatures) {
      if (sig.signature.length !== 65) {
        return false;
      }
    }

    return true;
  }
}

export default { VAAVerifier };
