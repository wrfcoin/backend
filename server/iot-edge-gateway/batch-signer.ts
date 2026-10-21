import nacl from 'tweetnacl';
import { randomUUID } from 'node:crypto';
import { bytesToHex, hexToBytes } from './device-auth.js';
import type { SensorReading, BatchTransaction } from './types.js';

const IOT_SERVER_URL =
  process.env.IOT_SERVER_URL || 'http://localhost:3002/sensors/aggregate-data';
const BATCH_INTERVAL_MS = parseInt(
  process.env.BATCH_INTERVAL_MS || '30000',
  10,
);

export class BatchSigner {
  private buffer: SensorReading[] = [];
  private gatewayKeyPair: nacl.SignKeyPair;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastFlush: number = 0;

  constructor() {
    const envKey = process.env.GATEWAY_PRIVATE_KEY;
    if (envKey) {
      const seed = hexToBytes(envKey);
      this.gatewayKeyPair = nacl.sign.keyPair.fromSeed(seed);
    } else {
      console.warn(
        '[BatchSigner] GATEWAY_PRIVATE_KEY is unset; generated gateway keys are ephemeral and rotate on restart',
      );
      this.gatewayKeyPair = nacl.sign.keyPair();
    }
  }

  /** Start the automatic flush interval. */
  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[BatchSigner] auto-flush error:', err);
      });
    }, BATCH_INTERVAL_MS);
  }

  /** Stop the automatic flush interval. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Add a validated reading to the buffer. */
  addReading(reading: SensorReading): void {
    this.buffer.push(reading);
  }

  /** Number of readings waiting to be flushed. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** Timestamp of last flush (Unix ms). */
  get lastFlushTime(): number {
    return this.lastFlush;
  }

  /** Gateway public key as hex. */
  get gatewayPublicKey(): string {
    return bytesToHex(this.gatewayKeyPair.publicKey);
  }

  /**
   * Flush the buffer: sign readings as a batch and forward to the IoT server.
   * Returns the BatchTransaction if there were readings, or null if the buffer was empty.
   */
  async flush(): Promise<BatchTransaction | null> {
    if (this.buffer.length === 0) return null;

    const readings = this.buffer.splice(0, this.buffer.length);
    const batchId = randomUUID();
    const timestamp = Date.now();

    const encoder = new TextEncoder();
    const sigPayload = encoder.encode(
      JSON.stringify({ batchId, timestamp, readingCount: readings.length }),
    );
    const signature = nacl.sign.detached(sigPayload, this.gatewayKeyPair.secretKey);

    const batch: BatchTransaction = {
      readings,
      batchId,
      gatewaySignature: bytesToHex(signature),
      timestamp,
      readingCount: readings.length,
    };

    this.lastFlush = timestamp;

    try {
      const res = await fetch(IOT_SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.warn(
          `[BatchSigner] IoT server returned ${res.status}: ${res.statusText}`,
        );
      }
    } catch (err) {
      console.error('[BatchSigner] failed to forward batch to IoT server:', err);
    }

    return batch;
  }
}
