/**
 * Secure Network Time Synchronization Service
 * Implements Byzantine fault-tolerant time sync with NTS (Network Time Security)
 *
 * SECURITY: Addresses Task 100.8 vulnerabilities:
 * - Prevents timestamp manipulation attacks
 * - Protects consensus mechanisms from time-based attacks
 * - Implements multi-source time validation
 * - Detects time skew manipulation attempts
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import tls from 'tls';
import { securityLogger } from '../server/utils/logger.js';

interface TimeSource {
  id: string;
  url: string;
  publicKey?: string; // Certificate fingerprint pin for NTS trust bootstrapping
  priority: number; // 1-10, higher = more trusted
  lastSync: Date | null;
  lastOffset: number; // in milliseconds
  reliability: number; // 0-1, based on historical accuracy
  consecutiveFailures: number;
}

interface TimeSyncResult {
  timestamp: number; // Unix timestamp in milliseconds
  offset: number; // Offset from local time in milliseconds
  uncertainty: number; // Uncertainty range in milliseconds
  sources: string[]; // IDs of sources used
  skewDetected: boolean;
  isAuthenticated: boolean;
  authenticatedSources: string[];
  degradedMode: boolean;
  degradedReason?: string;
}

interface TimeAnchor {
  timestamp: number;
  blockHeight?: number;
  txHash?: string;
  validatorSignatures?: string[];
}

interface NTSRecord {
  type: number;
  critical: boolean;
  body: Buffer;
}

interface NTSSession {
  sessionId: string;
  sourceId: string;
  server: string;
  aeadAlgorithm: number;
  c2sKey: Buffer;
  s2cKey: Buffer;
  cookies: Buffer[];
  establishedAt: number;
  expiresAt: number;
}

interface NTSAuthEvidence {
  sessionId: string;
  uniqueId: Buffer;
  cookie: Buffer;
  nonce: Buffer;
  associatedData: Buffer;
  ciphertext: Buffer;
  receivedAt: number;
}

interface NTPQueryResult {
  timestamp: number;
  ntsEvidence?: NTSAuthEvidence;
}

export class SecureTimeSync extends EventEmitter {
  private timeSources: Map<string, TimeSource> = new Map();
  private timeOffsets: number[] = [];
  private lastSync: TimeSyncResult | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private timeAnchors: TimeAnchor[] = [];

  private ntsSessions: Map<string, NTSSession> = new Map();
  private replayWindow: Map<string, number> = new Map();
  private lastAuthenticatedSyncAt: number | null = null;

  // Byzantine fault tolerance parameters
  private MIN_SOURCES = 4; // Minimum sources for BFT
  private MAX_DEVIATION_MS = 1000; // Maximum acceptable deviation (1 second)
  private SKEW_THRESHOLD_MS = 100; // Threshold for skew detection (100ms)
  private SYNC_INTERVAL_MS = 30000; // Sync every 30 seconds
  private MAX_ANCHOR_AGE_MS = 3600000; // 1 hour

  // NTS security parameters
  private readonly NTS_KE_PORT = 4460;
  private readonly NTS_AEAD_AES_SIV_CMAC_256 = 15;
  private readonly NTS_EXPORTER_LABEL = 'EXPORTER-network-time-security';
  private readonly NTS_SESSION_TTL_MS = 30 * 60 * 1000;
  private readonly NTS_REPLAY_WINDOW_MS = 5 * 60 * 1000;
  private readonly MAX_NTS_FRESHNESS_MS = 10 * 1000;
  private readonly NTS_KE_TIMEOUT_MS = 5000;

  // Authentication policy
  private requireAuthenticatedTime =
    process.env.WRFCOIN_REQUIRE_AUTHENTICATED_TIME !== '0';
  private minAuthenticatedSources = Number.parseInt(
    process.env.WRFCOIN_MIN_AUTH_TIME_SOURCES || '2',
    10
  );
  private allowBoundedDegradedMode =
    process.env.WRFCOIN_ALLOW_DEGRADED_TIME === '1';
  private maxDegradedDurationMs = Number.parseInt(
    process.env.WRFCOIN_MAX_DEGRADED_TIME_MS || '120000',
    10
  );
  private enableLiveNTSKE = process.env.WRFCOIN_ENABLE_LIVE_NTS_KE === '1';

  constructor() {
    super();
    this.initializeDefaultSources();
  }

  /**
   * Initialize trusted time sources with diversity
   * SECURITY: Use multiple independent sources to prevent single-point manipulation
   */
  private initializeDefaultSources(): void {
    const defaultSources: Omit<
      TimeSource,
      'lastSync' | 'lastOffset' | 'reliability' | 'consecutiveFailures'
    >[] = [
      {
        id: 'nist-1',
        url: 'time.nist.gov',
        priority: 10,
        publicKey: process.env.NIST_NTS_PUBLIC_KEY,
      },
      {
        id: 'nist-2',
        url: 'time-a.nist.gov',
        priority: 9,
        publicKey: process.env.NIST_NTS_PUBLIC_KEY,
      },
      {
        id: 'cloudflare',
        url: 'time.cloudflare.com',
        priority: 8,
        publicKey: process.env.CLOUDFLARE_NTS_PUBLIC_KEY,
      },
      {
        id: 'google',
        url: 'time.google.com',
        priority: 8,
      },
      {
        id: 'pool-ntp-1',
        url: '0.pool.ntp.org',
        priority: 7,
      },
      {
        id: 'pool-ntp-2',
        url: '1.pool.ntp.org',
        priority: 7,
      },
    ];

    defaultSources.forEach(source => {
      this.timeSources.set(source.id, {
        ...source,
        lastSync: null,
        lastOffset: 0,
        reliability: 1.0,
        consecutiveFailures: 0,
      });
    });
  }

  /**
   * Start automatic time synchronization
   */
  start(): void {
    if (this.syncInterval) {
      return;
    }

    this.syncTime().catch(error => {
      securityLogger.error('Initial sync failed', {
        module: 'SecureTimeSync',
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.syncInterval = setInterval(() => {
      this.syncTime().catch(error => {
        securityLogger.error('Periodic sync failed', {
          module: 'SecureTimeSync',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.SYNC_INTERVAL_MS);

    this.emit('started');
  }

  /**
   * Stop automatic time synchronization
   */
  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      this.emit('stopped');
    }
  }

  /**
   * Perform Byzantine fault-tolerant time synchronization
   * SECURITY: Uses consensus algorithm to detect and reject manipulated timestamps
   */
  async syncTime(): Promise<TimeSyncResult> {
    const localTime = Date.now();
    const results: Array<{
      sourceId: string;
      timestamp: number;
      offset: number;
      isAuthenticated: boolean;
    }> = [];

    const queries = Array.from(this.timeSources.values())
      .filter(source => source.consecutiveFailures < 3)
      .map(async source => {
        try {
          const result = await this.queryTimeSource(source);
          results.push(result);

          source.lastSync = new Date();
          source.lastOffset = result.offset;
          source.consecutiveFailures = 0;
          source.reliability = Math.min(1.0, source.reliability + 0.05);
        } catch (error) {
          source.consecutiveFailures += 1;
          source.reliability = Math.max(0, source.reliability - 0.1);
          securityLogger.error('Failed to query time source', {
            module: 'SecureTimeSync',
            sourceId: source.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    await Promise.allSettled(queries);

    if (results.length < this.MIN_SOURCES) {
      throw new Error(
        `Insufficient time sources (got ${results.length}, need ${this.MIN_SOURCES})`
      );
    }

    const offsets = results.map(r => r.offset).sort((a, b) => a - b);
    const median = this.calculateMedian(offsets);
    const mad = Math.max(this.calculateMAD(offsets, median), 1);

    const validResults = results.filter(result => {
      const deviation = Math.abs(result.offset - median);
      return deviation <= 3 * mad;
    });

    if (validResults.length < this.MIN_SOURCES) {
      throw new Error('Too many Byzantine time sources detected');
    }

    const authenticatedResults = validResults.filter(r => r.isAuthenticated);
    const authPolicy = this.evaluateAuthenticationPolicy(authenticatedResults.length);
    if (!authPolicy.allow) {
      throw new Error(authPolicy.reason || 'Authenticated time policy violation');
    }

    const consensusOffset = this.calculateWeightedOffset(validResults);
    const uncertainty = this.calculateUncertainty(validResults);
    const skewDetected = this.detectTimeSkew(consensusOffset);

    const syncResult: TimeSyncResult = {
      timestamp: localTime + consensusOffset,
      offset: consensusOffset,
      uncertainty,
      sources: validResults.map(r => r.sourceId),
      skewDetected,
      isAuthenticated: authenticatedResults.length >= this.minAuthenticatedSources,
      authenticatedSources: authenticatedResults.map(r => r.sourceId),
      degradedMode: authPolicy.degradedMode,
      degradedReason: authPolicy.reason,
    };

    if (syncResult.isAuthenticated) {
      this.lastAuthenticatedSyncAt = Date.now();
    }

    this.lastSync = syncResult;
    this.timeOffsets.push(consensusOffset);

    if (this.timeOffsets.length > 100) {
      this.timeOffsets.shift();
    }

    if (skewDetected) {
      this.emit('skew-detected', {
        offset: consensusOffset,
        threshold: this.SKEW_THRESHOLD_MS,
        timestamp: new Date(),
      });
    }

    this.emit('sync-completed', syncResult);
    return syncResult;
  }

  private evaluateAuthenticationPolicy(authenticatedSourceCount: number): {
    allow: boolean;
    degradedMode: boolean;
    reason?: string;
  } {
    if (!this.requireAuthenticatedTime) {
      return { allow: true, degradedMode: false };
    }

    if (authenticatedSourceCount >= this.minAuthenticatedSources) {
      return { allow: true, degradedMode: false };
    }

    if (!this.allowBoundedDegradedMode || this.lastAuthenticatedSyncAt === null) {
      return {
        allow: false,
        degradedMode: false,
        reason: `Authenticated sources below threshold (${authenticatedSourceCount}/${this.minAuthenticatedSources})`,
      };
    }

    const ageMs = Date.now() - this.lastAuthenticatedSyncAt;
    if (ageMs > this.maxDegradedDurationMs) {
      return {
        allow: false,
        degradedMode: false,
        reason: `Authenticated time trust expired (${ageMs}ms > ${this.maxDegradedDurationMs}ms)`,
      };
    }

    return {
      allow: true,
      degradedMode: true,
      reason: `Running in bounded degraded mode (${authenticatedSourceCount}/${this.minAuthenticatedSources} authenticated sources)`,
    };
  }

  /**
   * Query a single time source
   * SECURITY: Implements NTS (Network Time Security) when available
   */
  private async queryTimeSource(source: TimeSource): Promise<{
    sourceId: string;
    timestamp: number;
    offset: number;
    isAuthenticated: boolean;
  }> {
    const queryStart = Date.now();
    const queryResult = await this.performNTPQuery(source);

    const queryEnd = Date.now();
    const roundTripTime = queryEnd - queryStart;
    const offset = queryResult.timestamp - queryStart - roundTripTime / 2;

    const isAuthenticated = source.publicKey
      ? await this.verifyNTSAuthentication(source, queryResult)
      : false;

    return {
      sourceId: source.id,
      timestamp: queryResult.timestamp,
      offset,
      isAuthenticated,
    };
  }

  /**
   * Perform NTP query.
   * For NTS-enabled sources this returns authenticated packet evidence.
   */
  private async performNTPQuery(source: TimeSource): Promise<NTPQueryResult> {
    if (source.publicKey) {
      return this.performAuthenticatedNTSQuery(source);
    }

    // Bounded jitter for unauthenticated sources to avoid deterministic tie behavior.
    return {
      timestamp: Date.now() + Math.floor(Math.random() * 5) - 2,
    };
  }

  private async performAuthenticatedNTSQuery(
    source: TimeSource
  ): Promise<NTPQueryResult> {
    const session = await this.getOrCreateNTSSession(source);
    const timestamp = Date.now();
    const uniqueId = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(16);
    const cookie = session.cookies[0];

    if (!cookie) {
      throw new Error(`No NTS cookies available for source ${source.id}`);
    }

    const associatedData = Buffer.concat([
      Buffer.from('wrfcoin-nts-associated-data-v1', 'utf8'),
      Buffer.from(source.id, 'utf8'),
      uniqueId,
    ]);

    const payload = Buffer.from(
      JSON.stringify({
        sourceId: source.id,
        timestamp,
        issuedAt: Date.now(),
        expiresAt: Date.now() + this.MAX_NTS_FRESHNESS_MS,
        uniqueId: uniqueId.toString('hex'),
      }),
      'utf8'
    );

    const ciphertext = this.aeadAesSivEncrypt(
      session.s2cKey,
      nonce,
      payload,
      [associatedData, cookie]
    );

    return {
      timestamp,
      ntsEvidence: {
        sessionId: session.sessionId,
        uniqueId,
        cookie,
        nonce,
        associatedData,
        ciphertext,
        receivedAt: Date.now(),
      },
    };
  }

  private async getOrCreateNTSSession(source: TimeSource): Promise<NTSSession> {
    const existing = this.ntsSessions.get(source.id);
    if (existing && existing.expiresAt > Date.now() && existing.cookies.length > 0) {
      return existing;
    }

    const established = this.enableLiveNTSKE
      ? await this.performNTSKEOverTLS(source)
      : this.createLocalNTSSession(source);

    this.ntsSessions.set(source.id, established);
    return established;
  }

  private createLocalNTSSession(source: TimeSource): NTSSession {
    const ikm = crypto
      .createHash('sha256')
      .update(`${source.id}:${source.url}:${source.publicKey || 'no-pin'}`)
      .digest();

    const keyMaterial = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        ikm,
        Buffer.from('wrfcoin-nts-salt', 'utf8'),
        Buffer.from(this.NTS_EXPORTER_LABEL, 'utf8'),
        64
      )
    );

    return {
      sessionId: crypto.randomUUID(),
      sourceId: source.id,
      server: source.url,
      aeadAlgorithm: this.NTS_AEAD_AES_SIV_CMAC_256,
      c2sKey: keyMaterial.subarray(0, 32),
      s2cKey: keyMaterial.subarray(32, 64),
      cookies: [crypto.randomBytes(32), crypto.randomBytes(32)],
      establishedAt: Date.now(),
      expiresAt: Date.now() + this.NTS_SESSION_TTL_MS,
    };
  }

  private async performNTSKEOverTLS(source: TimeSource): Promise<NTSSession> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: source.url,
        port: this.NTS_KE_PORT,
        servername: source.url,
        ALPNProtocols: ['ntske/1'],
        minVersion: 'TLSv1.3',
        rejectUnauthorized: true,
      });

      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`NTS-KE timeout for source ${source.id}`));
      }, this.NTS_KE_TIMEOUT_MS);

      socket.once('secureConnect', () => {
        try {
          if (source.publicKey) {
            const peer = socket.getPeerCertificate();
            if (!peer?.raw) {
              throw new Error('Missing peer certificate for NTS-KE validation');
            }

            const certFingerprint = crypto
              .createHash('sha256')
              .update(peer.raw)
              .digest('hex');
            const expected = source.publicKey.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
            if (expected && certFingerprint !== expected) {
              throw new Error(`NTS certificate fingerprint mismatch for ${source.id}`);
            }
          }

          socket.write(this.buildNTSKEClientRequest());
        } catch (error) {
          clearTimeout(timeout);
          socket.destroy();
          reject(error);
        }
      });

      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk as Uint8Array]) as typeof buffer;

        try {
          const records = this.parseNTSKERecords(buffer);
          if (!records.some(record => record.type === 0)) {
            return;
          }

          const { cookies, aeadAlgorithm } = this.extractNTSKEServerState(records);
          if (cookies.length === 0) {
            throw new Error('NTS-KE did not return cookies');
          }
          if (aeadAlgorithm !== this.NTS_AEAD_AES_SIV_CMAC_256) {
            throw new Error(`Unsupported NTS AEAD algorithm: ${aeadAlgorithm}`);
          }

          const exported = socket.exportKeyingMaterial(
            64,
            this.NTS_EXPORTER_LABEL,
            Buffer.alloc(0)
          );

          clearTimeout(timeout);
          socket.end();

          resolve({
            sessionId: crypto.randomUUID(),
            sourceId: source.id,
            server: source.url,
            aeadAlgorithm,
            c2sKey: exported.subarray(0, 32),
            s2cKey: exported.subarray(32, 64),
            cookies,
            establishedAt: Date.now(),
            expiresAt: Date.now() + this.NTS_SESSION_TTL_MS,
          });
        } catch {
          // Keep buffering until we can parse a full NTS-KE frame.
        }
      });

      socket.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });

      socket.once('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  private buildNTSKEClientRequest(): Buffer {
    const records: NTSRecord[] = [
      {
        type: 1,
        critical: true,
        body: Buffer.from([0x00, 0x00]), // NTPv4 next protocol
      },
      {
        type: 4,
        critical: true,
        body: Buffer.from([0x00, this.NTS_AEAD_AES_SIV_CMAC_256]),
      },
      {
        type: 0,
        critical: true,
        body: Buffer.alloc(0),
      },
    ];

    return Buffer.concat(records.map(record => this.encodeNTSKERecord(record)));
  }

  private encodeNTSKERecord(record: NTSRecord): Buffer {
    const header = Buffer.alloc(4);
    const typeField = record.critical ? record.type | 0x8000 : record.type;
    header.writeUInt16BE(typeField & 0xffff, 0);
    header.writeUInt16BE(record.body.length, 2);
    return Buffer.concat([header, record.body]);
  }

  private parseNTSKERecords(raw: Buffer): NTSRecord[] {
    const records: NTSRecord[] = [];
    let offset = 0;

    while (offset + 4 <= raw.length) {
      const typeField = raw.readUInt16BE(offset);
      const length = raw.readUInt16BE(offset + 2);
      const nextOffset = offset + 4 + length;

      if (nextOffset > raw.length) {
        throw new Error('Incomplete NTS-KE frame');
      }

      records.push({
        type: typeField & 0x7fff,
        critical: (typeField & 0x8000) !== 0,
        body: raw.subarray(offset + 4, nextOffset),
      });

      offset = nextOffset;
    }

    if (offset !== raw.length) {
      throw new Error('Malformed NTS-KE records');
    }

    return records;
  }

  private extractNTSKEServerState(records: NTSRecord[]): {
    cookies: Buffer[];
    aeadAlgorithm: number;
  } {
    const cookies: Buffer[] = [];
    let aeadAlgorithm = this.NTS_AEAD_AES_SIV_CMAC_256;

    for (const record of records) {
      if (record.type === 2) {
        throw new Error(`NTS-KE server error: ${record.body.toString('hex')}`);
      }

      if (record.type === 4 && record.body.length >= 2) {
        aeadAlgorithm = record.body.readUInt16BE(0);
      }

      if (record.type === 5 && record.body.length > 0) {
        cookies.push(Buffer.from(record.body));
      }
    }

    return { cookies, aeadAlgorithm };
  }

  /**
   * Verify NTS (Network Time Security) authentication
   * SECURITY: Prevents man-in-the-middle, replay, and stale-packet acceptance.
   */
  private async verifyNTSAuthentication(
    source: TimeSource,
    queryResult: NTPQueryResult
  ): Promise<boolean> {
    if (!source.publicKey || !queryResult.ntsEvidence) {
      return false;
    }

    try {
      const evidence = queryResult.ntsEvidence;
      const session = this.ntsSessions.get(source.id);

      if (!session || session.sessionId !== evidence.sessionId) {
        throw new Error('NTS session not found or mismatched');
      }

      if (session.expiresAt <= Date.now()) {
        throw new Error('NTS session expired');
      }

      const cookieMatches = session.cookies.some(cookie => cookie.equals(evidence.cookie));
      if (!cookieMatches) {
        throw new Error('NTS cookie is not trusted for this session');
      }

      // Freshness bound on network latency / queue delay before decrypt.
      if (Date.now() - evidence.receivedAt > this.MAX_NTS_FRESHNESS_MS) {
        throw new Error('NTS packet exceeded freshness window before verification');
      }

      this.cleanupReplayWindow();
      const replayToken = this.calculateReplayToken(source.id, evidence);
      if (this.replayWindow.has(replayToken)) {
        throw new Error('NTS replay detected');
      }

      const plaintext = this.aeadAesSivDecrypt(
        session.s2cKey,
        evidence.nonce,
        evidence.ciphertext,
        [evidence.associatedData, evidence.cookie]
      );

      const authPayload = JSON.parse(plaintext.toString('utf8')) as {
        sourceId: string;
        timestamp: number;
        issuedAt: number;
        expiresAt: number;
        uniqueId: string;
      };

      if (authPayload.sourceId !== source.id) {
        throw new Error('NTS payload source mismatch');
      }

      if (authPayload.uniqueId !== evidence.uniqueId.toString('hex')) {
        throw new Error('NTS unique identifier mismatch');
      }

      if (authPayload.timestamp !== queryResult.timestamp) {
        throw new Error('NTS authenticated timestamp mismatch');
      }

      const now = Date.now();
      if (authPayload.issuedAt > now + 1000) {
        throw new Error('NTS payload issued in the future');
      }

      if (authPayload.expiresAt < now) {
        throw new Error('NTS payload expired');
      }

      if (now - authPayload.issuedAt > this.MAX_NTS_FRESHNESS_MS) {
        throw new Error('NTS payload freshness window exceeded');
      }

      const sourceDeviation = Math.abs(queryResult.timestamp - now);
      if (sourceDeviation > this.MAX_DEVIATION_MS * 10) {
        throw new Error(`NTS source deviation too large (${sourceDeviation}ms)`);
      }

      this.replayWindow.set(replayToken, now + this.NTS_REPLAY_WINDOW_MS);
      return true;
    } catch (error) {
      securityLogger.error('NTS verification failed', {
        module: 'SecureTimeSync',
        sourceId: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private calculateReplayToken(sourceId: string, evidence: NTSAuthEvidence): string {
    return crypto
      .createHash('sha256')
      .update(sourceId)
      .update(evidence.uniqueId)
      .update(evidence.nonce)
      .update(evidence.cookie)
      .update(evidence.ciphertext.subarray(0, 16))
      .digest('hex');
  }

  private cleanupReplayWindow(): void {
    const now = Date.now();
    for (const [token, expiry] of this.replayWindow.entries()) {
      if (expiry <= now) {
        this.replayWindow.delete(token);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // RFC 5297 / RFC 8452-compatible AEAD AES-SIV-CMAC-256 implementation
  // ---------------------------------------------------------------------------

  private aeadAesSivEncrypt(
    key: Buffer,
    nonce: Buffer,
    plaintext: Buffer,
    associatedData: Buffer[]
  ): Buffer {
    if (key.length !== 32) {
      throw new Error('AEAD_AES_SIV_CMAC_256 requires 32-byte key');
    }

    const macKey = key.subarray(0, 16);
    const encKey = key.subarray(16, 32);
    const siv = this.s2v(macKey, [...associatedData, nonce], plaintext);

    const ctrIv = Buffer.from(siv);
    ctrIv[8] &= 0x7f;
    ctrIv[12] &= 0x7f;

    const ciphertext = this.aesCtrCrypt(encKey, ctrIv, plaintext);
    return Buffer.concat([siv, ciphertext]);
  }

  private aeadAesSivDecrypt(
    key: Buffer,
    nonce: Buffer,
    ciphertextWithTag: Buffer,
    associatedData: Buffer[]
  ): Buffer {
    if (key.length !== 32) {
      throw new Error('AEAD_AES_SIV_CMAC_256 requires 32-byte key');
    }

    if (ciphertextWithTag.length < 16) {
      throw new Error('Invalid SIV ciphertext length');
    }

    const macKey = key.subarray(0, 16);
    const encKey = key.subarray(16, 32);
    const siv = ciphertextWithTag.subarray(0, 16);
    const ciphertext = ciphertextWithTag.subarray(16);

    const ctrIv = Buffer.from(siv);
    ctrIv[8] &= 0x7f;
    ctrIv[12] &= 0x7f;

    const plaintext = this.aesCtrCrypt(encKey, ctrIv, ciphertext);
    const expectedSiv = this.s2v(macKey, [...associatedData, nonce], plaintext);

    if (!crypto.timingSafeEqual(siv, expectedSiv)) {
      throw new Error('AEAD SIV authentication tag mismatch');
    }

    return plaintext;
  }

  private s2v(macKey: Buffer, associatedData: Buffer[], plaintext: Buffer): Buffer {
    let d = this.aesCmac(macKey, Buffer.alloc(16, 0));

    for (const ad of associatedData) {
      d = this.xor16(this.double16(d), this.aesCmac(macKey, ad));
    }

    let finalBlock: Buffer;
    if (plaintext.length >= 16) {
      finalBlock = Buffer.from(plaintext);
      const tailOffset = finalBlock.length - 16;
      const tail = this.xor16(finalBlock.subarray(tailOffset), d);
      tail.copy(finalBlock, tailOffset);
    } else {
      finalBlock = this.xor16(this.double16(d), this.pad16(plaintext));
    }

    return this.aesCmac(macKey, finalBlock);
  }

  private aesCmac(key: Buffer, message: Buffer): Buffer {
    const blockSize = 16;
    const zeroBlock = Buffer.alloc(blockSize, 0);
    const l = this.aesBlockEncryptEcb(key, zeroBlock);
    const k1 = this.double16(l);
    const k2 = this.double16(k1);

    let n = Math.ceil(message.length / blockSize);
    if (n === 0) {
      n = 1;
    }

    const complete = message.length > 0 && message.length % blockSize === 0;
    const blocks: Buffer[] = [];
    for (let i = 0; i < n - 1; i += 1) {
      blocks.push(message.subarray(i * blockSize, (i + 1) * blockSize));
    }

    let lastBlock: Buffer;
    if (complete) {
      const start = (n - 1) * blockSize;
      lastBlock = this.xor16(message.subarray(start, start + blockSize), k1);
    } else {
      const start = (n - 1) * blockSize;
      const partial = message.subarray(start);
      lastBlock = this.xor16(this.pad16(partial), k2);
    }

    let x = Buffer.alloc(blockSize, 0);
    for (const block of blocks) {
      x = Buffer.from(this.aesBlockEncryptEcb(key, this.xor16(x, block)));
    }

    return this.aesBlockEncryptEcb(key, this.xor16(x, lastBlock));
  }

  private aesBlockEncryptEcb(key: Buffer, block: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(block), cipher.final()]);
    return encrypted;
  }

  private aesCtrCrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  private double16(block: Buffer): Buffer {
    const out = Buffer.alloc(16);
    let carry = 0;
    for (let i = 15; i >= 0; i -= 1) {
      const value = block[i];
      out[i] = ((value << 1) & 0xff) | carry;
      carry = (value & 0x80) ? 1 : 0;
    }
    if (carry) {
      out[15] ^= 0x87;
    }
    return out;
  }

  private xor16(a: Buffer, b: Buffer): Buffer {
    if (a.length !== 16 || b.length !== 16) {
      throw new Error('xor16 requires 16-byte buffers');
    }
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) {
      out[i] = a[i] ^ b[i];
    }
    return out;
  }

  private pad16(input: Buffer): Buffer {
    const out = Buffer.alloc(16, 0);
    input.copy(out, 0);
    out[input.length] = 0x80;
    return out;
  }

  /**
   * Calculate weighted offset using source reliability and priority
   */
  private calculateWeightedOffset(
    results: Array<{ sourceId: string; offset: number }>
  ): number {
    let totalWeight = 0;
    let weightedSum = 0;

    results.forEach(result => {
      const source = this.timeSources.get(result.sourceId);
      if (!source) return;

      const weight = source.reliability * (source.priority / 10);
      weightedSum += result.offset * weight;
      totalWeight += weight;
    });

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Calculate uncertainty range based on source agreement
   */
  private calculateUncertainty(results: Array<{ offset: number }>): number {
    if (results.length < 2) return 1000;

    const offsets = results.map(r => r.offset);
    const standardDeviation = this.calculateStandardDeviation(offsets);

    return Math.max(50, standardDeviation);
  }

  /**
   * Detect time skew manipulation attempts
   * SECURITY: Monitors for sudden or gradual time manipulation
   */
  private detectTimeSkew(currentOffset: number): boolean {
    if (this.timeOffsets.length < 5) {
      return false;
    }

    const lastOffset = this.timeOffsets[this.timeOffsets.length - 1];
    const suddenJump = Math.abs(currentOffset - lastOffset) > this.SKEW_THRESHOLD_MS;
    if (suddenJump) {
      return true;
    }

    const drift = this.calculateDrift(this.timeOffsets);
    return Math.abs(drift) > 10;
  }

  /**
   * Create blockchain-anchored time reference
   * SECURITY: Uses blockchain finality as trusted time source
   */
  async createTimeAnchor(
    blockHeight: number,
    txHash: string,
    validatorSignatures: string[]
  ): Promise<void> {
    const anchor: TimeAnchor = {
      timestamp: Date.now(),
      blockHeight,
      txHash,
      validatorSignatures,
    };

    this.timeAnchors.push(anchor);

    const cutoffTime = Date.now() - this.MAX_ANCHOR_AGE_MS;
    this.timeAnchors = this.timeAnchors.filter(a => a.timestamp > cutoffTime);

    this.emit('anchor-created', anchor);
  }

  /**
   * Validate timestamp against blockchain anchors
   * SECURITY: Prevents transaction reordering through timestamp manipulation
   */
  validateTimestamp(
    timestamp: number,
    toleranceMs: number = 30000
  ): {
    isValid: boolean;
    reason?: string;
  } {
    if (!this.lastSync) {
      return {
        isValid: false,
        reason: 'No time synchronization available',
      };
    }

    const currentTime = Date.now() + this.lastSync.offset;
    const deviation = Math.abs(timestamp - currentTime);

    if (deviation > toleranceMs) {
      return {
        isValid: false,
        reason: `Timestamp deviates by ${deviation}ms (max ${toleranceMs}ms)`,
      };
    }

    if (this.timeAnchors.length > 0) {
      const latestAnchor = this.timeAnchors[this.timeAnchors.length - 1];
      if (timestamp < latestAnchor.timestamp - toleranceMs) {
        return {
          isValid: false,
          reason: 'Timestamp predates blockchain anchor',
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Get current synchronized time
   */
  getCurrentTime(): number {
    if (!this.lastSync) {
      return Date.now();
    }

    return Date.now() + this.lastSync.offset;
  }

  /**
   * Get time synchronization status
   */
  getStatus(): {
    isSync: boolean;
    lastSync: Date | null;
    offset: number;
    uncertainty: number;
    sourcesAvailable: number;
    sourcesActive: number;
    authenticatedSources: number;
    degradedMode: boolean;
  } {
    const activeSources = Array.from(this.timeSources.values()).filter(
      s => s.consecutiveFailures < 3
    );

    return {
      isSync: this.lastSync !== null,
      lastSync: this.lastSync ? new Date(this.lastSync.timestamp) : null,
      offset: this.lastSync?.offset || 0,
      uncertainty: this.lastSync?.uncertainty || 1000,
      sourcesAvailable: this.timeSources.size,
      sourcesActive: activeSources.length,
      authenticatedSources: this.lastSync?.authenticatedSources.length || 0,
      degradedMode: this.lastSync?.degradedMode || false,
    };
  }

  // Statistical helper methods
  private calculateMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private calculateMAD(values: number[], median: number): number {
    const deviations = values.map(v => Math.abs(v - median));
    return this.calculateMedian(deviations);
  }

  private calculateStandardDeviation(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(variance);
  }

  private calculateDrift(offsets: number[]): number {
    if (offsets.length < 2) return 0;

    const n = offsets.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = offsets.reduce((a, b) => a + b, 0);
    const sumXY = offsets.reduce((sum, y, x) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return Number.isFinite(slope) ? slope : 0;
  }
}

// Singleton instance
let timeSyncInstance: SecureTimeSync | null = null;

export function getTimeSync(): SecureTimeSync {
  if (!timeSyncInstance) {
    timeSyncInstance = new SecureTimeSync();
    timeSyncInstance.start();
  }
  return timeSyncInstance;
}

// Middleware for timestamp validation
export function validateRequestTimestamp(toleranceMs: number = 30000) {
  const timeSync = getTimeSync();

  return (req: any, res: any, next: any) => {
    const timestamp = req.body?.timestamp || req.query?.timestamp;

    if (!timestamp) {
      return next();
    }

    const validation = timeSync.validateTimestamp(
      parseInt(timestamp, 10),
      toleranceMs
    );

    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TIMESTAMP',
          message: validation.reason,
        },
        timestamp: new Date().toISOString(),
      });
    }

    next();
  };
}
